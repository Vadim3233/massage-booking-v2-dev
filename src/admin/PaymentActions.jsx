import { useEffect, useRef, useState } from 'react'
import { actionLabels, paymentActions, paymentReviewApi } from './paymentReviewApi.js'
import { clientName, dateLabel, money, time } from './calendarPresentation.js'

function Confirmation({ action, booking, cancel, confirm, busy }) {
  const ref = useRef(null)
  useEffect(() => {
    const opener = document.activeElement
    const overflow = document.body.style.overflow
    const dialog = ref.current
    dialog.showModal()
    document.body.style.overflow = 'hidden'
    return () => { dialog.close(); document.body.style.overflow = overflow; opener?.focus({ preventScroll: true }) }
  }, [])
  const consequence = { reject: 'Reject this cash request and cancel the appointment. Its time will be released.', approve: 'Approve cash and confirm the appointment. This does not record payment received.', verify: 'Confirm that the bank transfer has actually arrived. This records payment received and confirms the appointment.', receive: 'Confirm that you have actually received this cash payment.' }[action]
  return <dialog ref={ref} className="admin-confirm" aria-labelledby="payment-confirm-title" onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) cancel() }}>
    <h2 id="payment-confirm-title">{actionLabels[action]}?</h2>
    <p><strong>{clientName(booking)}</strong></p><p>{dateLabel(booking.date)} · {time(booking.start_minutes)} · {money(booking.total_gbp)}</p>
    <p>{consequence}</p><div className="admin-payment-buttons"><button disabled={busy} onClick={cancel}>Go back</button><button disabled={busy} onClick={confirm}>{busy ? 'Saving…' : `Confirm ${actionLabels[action].toLowerCase()}`}</button></div>
  </dialog>
}
export default function PaymentActions({ booking, refresh }) {
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
      setMessage({ text: 'Payment action saved. Refreshing current status.' })
      await refresh()
    } catch (error) {
      setConfirmation(null)
      setMessage({ error: true, text: error.message })
      if (error.conflict) { try { await refresh() } catch { setMessage({ error: true, text: 'The booking changed. Could not refresh its status; please retry refresh.' }) } }
    } finally { locked.current = false; setBusy(false) }
  }
  return <div className="admin-payment-actions">
    <div className="admin-payment-buttons">{paymentActions(booking).map(action => <button key={action} disabled={busy} onClick={() => { setMessage(null); setConfirmation(action) }}>{actionLabels[action]}</button>)}</div>
    {message && <p role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    {confirmation && <Confirmation action={confirmation} booking={booking} cancel={() => setConfirmation(null)} confirm={submit} busy={busy} />}
  </div>
}
