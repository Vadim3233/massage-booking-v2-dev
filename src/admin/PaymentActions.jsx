import { useEffect, useRef, useState } from 'react'
import { actionLabels, paymentActions, paymentReviewApi } from './paymentReviewApi.js'
import { clientName, dateLabel, money, time } from './calendarPresentation.js'
import { acquireBodyScrollLock } from './dialogScrollLock.js'
import { toast } from '../ui/toast.js'

// The confirmation says what will be recorded, and its button says what happens: "Yes, £90.00 has arrived".
const CONSEQUENCES = {
  remove: 'Cancel this booking. Its time is released and it is recorded as cancelled. No charge is made and nothing is deleted.',
  approve: 'Approve cash and confirm the appointment. This does not record payment received.',
  verify: 'Check that the transfer has reached your bank. This records the payment as received and confirms the appointment.',
  receive: 'Confirm that you have actually received this cash payment.',
  receiveBank: 'Check that the transfer has reached your bank. This records the payment as received.',
}
const SHORT = { verify: 'Verify', approve: 'Approve', remove: 'Cancel', receive: 'Received', receiveBank: 'Received' }
const confirmLabel = (action, booking) => ({
  remove: 'Yes, cancel this booking',
  approve: 'Yes, approve cash',
  verify: `Yes, ${money(booking.total_gbp)} has arrived`,
  receive: `Yes, ${money(booking.total_gbp)} cash received`,
  receiveBank: `Yes, ${money(booking.total_gbp)} has arrived`,
}[action])
const doneMessage = (action, booking) => ({
  remove: `Booking cancelled · ${clientName(booking)}`,
  approve: `Cash approved · ${clientName(booking)}`,
  verify: `Transfer verified · ${clientName(booking)} ${money(booking.total_gbp)}`,
  receive: `Cash received · ${clientName(booking)} ${money(booking.total_gbp)}`,
  receiveBank: `Transfer received · ${clientName(booking)} ${money(booking.total_gbp)}`,
}[action])

function Confirmation({ action, booking, cancel, confirm, busy }) {
  const ref = useRef(null)
  useEffect(() => {
    const opener = document.activeElement
    const dialog = ref.current
    dialog.showModal()
    const releaseScrollLock = acquireBodyScrollLock()
    return () => {
      if (dialog.open) dialog.close()
      releaseScrollLock()
      opener?.focus({ preventScroll: true })
    }
  }, [])
  return <dialog ref={ref} className="admin-confirm" aria-labelledby="payment-confirm-title" aria-describedby="payment-confirm-what" onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) cancel() }}>
    <h2 id="payment-confirm-title">{actionLabels[action]}?</h2>
    <div className="admin-confirm-summary"><strong>{clientName(booking)}</strong><span>{dateLabel(booking.date)} · {time(booking.start_minutes)}</span><b className="figure">{money(booking.total_gbp)}</b></div>
    <p id="payment-confirm-what">{CONSEQUENCES[action]}</p>
    {(action === 'verify' || action === 'receiveBank') && booking.booking_reference && <p className="admin-confirm-ref">Look for the reference <strong>{booking.booking_reference}</strong> on your bank statement.</p>}
    <div className="admin-payment-buttons">
      <button className={action === 'remove' ? 'btn--danger-solid' : 'btn--primary'} disabled={busy} onClick={confirm}>{busy ? 'Saving…' : confirmLabel(action, booking)}</button>
      <button className="btn--quiet" disabled={busy} onClick={cancel}>Go back</button>
    </div>
  </dialog>
}

// The one thing to do next is filled in; removing is outlined in red and kept apart from it.
function buttonClass(action, booking) {
  if (action === 'remove') return 'btn--danger'
  const status = booking.booking_payments?.status
  if (action === 'approve' || (action === 'verify' && status === 'awaiting_verification')) return 'btn--primary'
  return ''
}

// `short` shows one word on each button (Verify, Cancel) where the card around it already says whose booking it is.
export default function PaymentActions({ booking, refresh, only, compact = false, short = compact }) {
  const [confirmation, setConfirmation] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const locked = useRef(false)
  const request = useRef(null)
  async function submit() {
    if (locked.current) return
    locked.current = true; setBusy(true); setMessage(null)
    const action = confirmation
    const fingerprint = `${action}:${booking.updated_at}:${booking.booking_payments.updated_at}`
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() }
    try {
      await paymentReviewApi.act(action, booking, request.current.id)
      setConfirmation(null)
      setMessage({ text: 'Saved.' })
      toast(doneMessage(action, booking))
      await refresh()
    } catch (error) {
      setConfirmation(null)
      setMessage({ error: true, text: error.message })
      if (error.conflict) { try { await refresh() } catch { setMessage({ error: true, text: 'The booking changed. Could not refresh its status; please retry refresh.' }) } }
    } finally { locked.current = false; setBusy(false) }
  }
  const available = paymentActions(booking).filter(action => !only || only.includes(action))
  if (!available.length && !message && !confirmation) return null
  return <div className={`admin-payment-actions ${compact ? 'is-compact' : ''}`}>
    <div className="admin-payment-buttons">{available.map(action => <button key={action} className={`${buttonClass(action, booking)} ${compact ? 'btn--small' : ''}`} aria-label={compact ? `${actionLabels[action]}, ${clientName(booking)} ${money(booking.total_gbp)}` : short ? actionLabels[action] : undefined} disabled={busy} onClick={() => { setMessage(null); setConfirmation(action) }}>{short ? SHORT[action] : actionLabels[action]}</button>)}</div>
    {message && <p role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    {confirmation && <Confirmation action={confirmation} booking={booking} cancel={() => setConfirmation(null)} confirm={submit} busy={busy} />}
  </div>
}
