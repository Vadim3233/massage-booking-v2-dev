import { useEffect, useRef, useState } from 'react'
import { dateLabel, money, time } from './calendarPresentation.js'
import { detailsPayload, EMPTY_DETAILS, NEEDS_DETAILS, receiptsApi, validateReceiptEdit, whatsappReceiptLink } from './receiptsApi.js'
import { receiptEditedAfterEmail, receiptEmailState } from './receiptState.js'
import { downloadReceiptPdf } from '../lib/receiptPdf.js'

const METHODS = { bank_transfer: 'bank transfer', cash: 'cash' }
const LONG_DAY = { day: 'numeric', month: 'long', year: 'numeric' }
const london = options => value => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', ...options }).format(new Date(value))
const paidOn = london(LONG_DAY)
const shortDay = london({ day: 'numeric', month: 'short', year: 'numeric' })

// The receipt as an A4 PDF, for the client to keep or send to their insurer. A receipt that no longer shows money received says so on the PDF.
function PdfButton({ receipt, primary = false }) {
  const [state, setState] = useState('')
  async function download() {
    setState('busy')
    try { await downloadReceiptPdf(receipt); setState('') } catch { setState('failed') }
  }
  return <>
    <button className={primary ? 'btn--tonal' : 'btn--quiet'} disabled={state === 'busy'} onClick={download}>{state === 'busy' ? 'Making the PDF…' : 'Download PDF'}</button>
    {state === 'failed' && <p role="alert" className="admin-field-error">Could not make the PDF. Check your connection and try again.</p>}
  </>
}

// The receipt as the client will read it. The amounts and the payment come from the booking and are not editable.
function ReceiptCard({ receipt, edit, busy, cardRef }) {
  const s = receipt.snapshot
  const contact = [s.business.phone, s.business.email, s.business.website].filter(Boolean).join(' · ')
  const credentials = s.business.practitioner_name && [s.business.practitioner_name, s.business.practitioner_title, s.business.association,
    s.business.membership_number && `membership number ${s.business.membership_number}`].filter(Boolean).join(', ')
  return <article className="admin-receipt" aria-label={`Receipt ${receipt.number}`} ref={cardRef} tabIndex={-1}>
    <header><h4>Receipt</h4><p className="admin-receipt-number">{receipt.number}</p></header>
    <p className="admin-receipt-small">Issued {dateLabel(s.issued_on, LONG_DAY)}</p>
    <p className="admin-receipt-business"><strong>{s.business.name}</strong>{contact && <span>{contact}</span>}{s.business.address && <span className="admin-receipt-address">{s.business.address}</span>}</p>
    <p className="admin-receipt-label">Received from</p>
    <p>{s.billed_to} · booking {s.reference}</p>
    <p className="admin-receipt-label">Appointment</p>
    <p>{dateLabel(s.appointment.date, { weekday: 'long', ...LONG_DAY })}, {time(s.appointment.start_minutes)} ({s.appointment.duration_minutes} minutes)</p>
    <dl className="admin-receipt-lines">
      {s.lines.map((line, index) => <div key={index}><dt>{line.label}</dt><dd>{money(line.amount)}</dd></div>)}
      <div className="is-total"><dt>Total paid</dt><dd>{money(s.total)}</dd></div>
    </dl>
    <p className="admin-receipt-small">Paid by {METHODS[s.payment.method] || String(s.payment.method || 'payment').replace(/_/g, ' ')} on {paidOn(s.payment.paid_at)}.</p>
    {credentials && <p className="admin-receipt-small">{credentials}</p>}
    {s.note && <p className="admin-receipt-note">{s.note}</p>}
    {s.business.closing && <p className="admin-receipt-note">{s.business.closing}</p>}
    <button className="btn--quiet btn--small admin-receipt-edit" disabled={busy} aria-label={`Edit receipt ${receipt.number}`} onClick={edit}>Edit</button>
  </article>
}

// Correcting the words on this one receipt: who it is for, a note, what each line says, and her details.
function ReceiptEdit({ receipt, save, cancel, busy, error }) {
  const s = receipt.snapshot
  const [billedTo, setBilledTo] = useState(s.billed_to)
  const [note, setNote] = useState(s.note || '')
  const [lines, setLines] = useState(s.lines.map(line => line.label))
  const [business, setBusiness] = useState({ ...EMPTY_DETAILS, ...s.business })
  const problem = validateReceiptEdit({ billed_to: billedTo, lines, business })
  const setLine = (index, value) => setLines(list => list.map((item, position) => (position === index ? value : item)))
  const setBusinessField = patch => setBusiness(current => ({ ...current, ...patch }))
  function submit(event) {
    event.preventDefault()
    if (busy || problem) return
    save({ billed_to: billedTo.trim(), note: note.trim() || null, lines: lines.map(line => line.trim()),
      business: Object.fromEntries(Object.entries(detailsPayload(business)).filter(([, value]) => value !== null)) })
  }
  return <form className="admin-client-form admin-receipt-form" onSubmit={submit} aria-label={`Edit receipt ${receipt.number}`}>
    <p className="admin-detail-hint">The amounts, the receipt number, and how and when it was paid come from the booking, so they cannot be changed here. The payment date is the day you marked the payment as received.</p>
    <label className="admin-field">Received from<input autoFocus value={billedTo} maxLength={120} disabled={busy} onChange={event => setBilledTo(event.target.value)} /></label>
    <label className="admin-field">Note on the receipt (optional)<textarea rows={2} maxLength={300} value={note} disabled={busy} onChange={event => setNote(event.target.value)} /></label>
    <fieldset className="admin-address-fieldset"><legend>What each line says</legend>
      {lines.map((line, index) => <label className="admin-field" key={index}>Line {index + 1}, {money(s.lines[index].amount)}<input value={line} maxLength={120} disabled={busy} onChange={event => setLine(index, event.target.value)} /></label>)}
    </fieldset>
    <fieldset className="admin-address-fieldset"><legend>Your details on this receipt</legend>
      <label className="admin-field">Business name<input value={business.name} maxLength={120} disabled={busy} onChange={event => setBusinessField({ name: event.target.value })} /></label>
      <div className="admin-hours-fields">
        <label className="admin-field">Phone<input type="tel" value={business.phone} maxLength={40} disabled={busy} onChange={event => setBusinessField({ phone: event.target.value })} /></label>
        <label className="admin-field">Email<input type="email" value={business.email} maxLength={254} disabled={busy} onChange={event => setBusinessField({ email: event.target.value })} /></label>
      </div>
      <label className="admin-field">Address (optional)<textarea rows={3} maxLength={300} value={business.address} disabled={busy} onChange={event => setBusinessField({ address: event.target.value })} /></label>
      <label className="admin-field">Website<input value={business.website} maxLength={120} disabled={busy} onChange={event => setBusinessField({ website: event.target.value })} /></label>
      <label className="admin-field">Closing line (optional)<input value={business.closing} maxLength={200} disabled={busy} onChange={event => setBusinessField({ closing: event.target.value })} /></label>
    </fieldset>
    <fieldset className="admin-address-fieldset"><legend>Practitioner credentials on this receipt</legend>
      <label className="admin-field">Your full name<input value={business.practitioner_name} maxLength={120} disabled={busy} onChange={event => setBusinessField({ practitioner_name: event.target.value })} /></label>
      <label className="admin-field">Professional title (optional)<input value={business.practitioner_title} maxLength={120} disabled={busy} onChange={event => setBusinessField({ practitioner_title: event.target.value })} /></label>
      <label className="admin-field">Professional association<input value={business.association} maxLength={160} disabled={busy} onChange={event => setBusinessField({ association: event.target.value })} /></label>
      <label className="admin-field">Membership number<input value={business.membership_number} maxLength={40} disabled={busy} onChange={event => setBusinessField({ membership_number: event.target.value })} /></label>
    </fieldset>
    {problem && <p role="alert" className="admin-field-error">{problem}</p>}
    {error && <p role="alert" className="admin-field-error">{error}</p>}
    <div className="admin-payment-buttons">
      <button type="button" className="btn--quiet" disabled={busy} onClick={cancel}>Cancel</button>
      <button type="submit" className="btn--primary" disabled={busy || Boolean(problem)}>{busy ? 'Saving…' : 'Save changes'}</button>
    </div>
  </form>
}

// What became of the latest email of this receipt, said only as far as it is known: waiting, sent, trying again, or given up.
function EmailStatus({ state, busy, check, statusRef }) {
  if (!state) return null
  const words = {
    sent: `Emailed to ${state.to} on ${shortDay(state.at)}.`,
    queued: `Email queued for ${state.to}. It usually goes within a few minutes.`,
    stuck: `The email to ${state.to} is still waiting to be sent. Check again in a few minutes, or send the receipt by WhatsApp or Share instead.`,
    retrying: `The email to ${state.to} has not gone through yet. It will try again by itself.`,
    failed: `The email to ${state.to} could not be sent. Press Email to try again, or send the receipt by WhatsApp or Share.`,
    unknown: `An email to ${state.to} was queued on ${shortDay(state.at)}. There is no record of whether it was delivered.`,
  }[state.status]
  const canCheck = ['queued', 'stuck', 'retrying'].includes(state.status)
  return <div className="admin-detail-hint">
    <p role="status" tabIndex={-1} ref={statusRef}>{words}</p>
    {canCheck && <button className="btn--quiet btn--small" disabled={busy} onClick={check}>Check if it was sent</button>}
  </div>
}

// On a booking whose payment has been received: open its receipt, send it, and correct it if she needs to.
export default function ReceiptPanel({ booking, openPage, api = receiptsApi }) {
  const [receipt, setReceipt] = useState(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const cardRef = useRef(null)
  const statusRef = useRef(null)
  // Where focus should go if the button just pressed disappears with the answer (the status line, or the receipt), so it is never lost.
  const focusAfter = useRef(null)
  // The key of an email that was asked for but not confirmed (the connection dropped), so pressing again can never send it twice.
  // It is cleared once the answer arrives, whenever the receipt changes (then the next email is a different one), and whenever the
  // receipt is read again with no request still on its way: she has then seen what became of the email, so the next press is deliberate.
  const emailRequest = useRef(null)
  const sending = useRef(0)
  const forgetUnconfirmedEmail = () => { if (sending.current === 0) emailRequest.current = null }
  // The button she pressed, so focus can go back to it if the browser dropped it while the buttons were switched off.
  const pressed = useRef(null)
  const client = booking.clients || {}
  const email = booking.booking_email_snapshot || client.email || ''
  const first = client.first_name || 'the client'
  // A very long name would push a button off the screen, so buttons use the start of it.
  const shortFirst = first.length > 18 ? `${first.slice(0, 17)}…` : first
  // When the receipt opens, or the form closes, focus goes to the receipt, so a keyboard or screen reader is not left at the top of the page.
  const showing = Boolean(receipt) && !editing
  useEffect(() => { if (showing) cardRef.current?.focus({ preventScroll: false }) }, [showing, receipt?.id])
  useEffect(() => {
    const target = focusAfter.current
    if (!target) return
    focusAfter.current = null
    if (document.activeElement && document.activeElement !== document.body) return
    (target === 'card' ? cardRef : statusRef).current?.focus()
  }, [receipt])
  // Whenever the booking is read again (after an action, or "Check for changes"), ask for the receipt again too, so what became of its
  // email, or a move of the appointment, shows without closing and reopening it.
  const seenBooking = useRef(booking)
  useEffect(() => {
    if (seenBooking.current === booking) return undefined
    seenBooking.current = booking
    if (!receipt) return undefined
    let current = true
    api.get(booking.id).then(next => { if (current && next) { forgetUnconfirmedEmail(); setReceipt(next) } }, () => {})
    return () => { current = false }
  }, [booking, receipt, api])
  useEffect(() => {
    if (busy || !pressed.current) return
    const element = pressed.current
    pressed.current = null
    if (document.activeElement === document.body && element.isConnected) element.focus()
  }, [busy])
  async function act(work) {
    if (busy) return null
    pressed.current = document.activeElement
    setBusy(true); setError(''); setMessage('')
    try { return await work() } catch (failure) { setError(failure.message); return null } finally { setBusy(false) }
  }
  async function open() { const next = await act(() => api.issue(booking.id)); if (next) setReceipt(next) }
  async function send() {
    if (!emailRequest.current) emailRequest.current = crypto.randomUUID()
    const key = emailRequest.current
    sending.current += 1
    const next = await act(() => api.email(booking.id, key)).finally(() => { sending.current -= 1 })
    if (next) { emailRequest.current = null; setReceipt(next) }
  }
  async function save(changes) {
    const next = await act(() => api.edit(booking.id, changes))
    if (next) { emailRequest.current = null; setReceipt(next); setEditing(false); setMessage('Saved.') }
  }
  async function updateAppointment() {
    const next = await act(() => api.edit(booking.id, { sync_appointment: true }))
    if (next) { emailRequest.current = null; focusAfter.current = 'card'; setReceipt(next); setMessage('The date and time on the receipt are up to date.') }
  }
  async function check() {
    const next = await act(() => api.get(booking.id))
    if (next) { forgetUnconfirmedEmail(); focusAfter.current = 'status'; setReceipt(next) }
  }
  // The phone's own share sheet where there is one (it offers WhatsApp, Messages and Mail); otherwise the text is copied.
  async function share() {
    setError(''); setMessage('')
    try {
      if (navigator.share) { await navigator.share({ title: `Receipt ${receipt.number}`, text: receipt.message }); return }
      await navigator.clipboard.writeText(receipt.message)
      setMessage('Copied. Paste it into a message to send it.')
    } catch (failure) {
      if (failure?.name === 'AbortError') return
      try { await navigator.clipboard.writeText(receipt.message); setMessage('Copied. Paste it into a message to send it.') } catch { setError('Could not share or copy. Select the receipt and copy it by hand.') }
    }
  }

  if (!receipt) {
    return <div className="admin-receipt-panel">
      <div className="admin-payment-buttons"><button className="btn--tonal" disabled={busy} onClick={open}>{busy ? 'Opening…' : 'Receipt'}</button></div>
      {error === NEEDS_DETAILS
        ? <div role="alert" className="admin-conflicts"><p>Save your business details first: More, Receipt details.</p>{openPage && <button onClick={() => openPage('/admin/settings/receipts')}>Open Receipt details</button>}</div>
        : error && <p role="alert" className="admin-field-error">{error}</p>}
    </div>
  }
  const whatsapp = whatsappReceiptLink(client.phone, receipt.message)
  const mail = receiptEmailState(receipt)
  if (editing) return <div className="admin-receipt-panel"><ReceiptEdit receipt={receipt} save={save} cancel={() => { setEditing(false); setError('') }} busy={busy} error={error} /></div>
  return <div className="admin-receipt-panel">
    <ReceiptCard receipt={receipt} edit={() => { setEditing(true); setError(''); setMessage('') }} busy={busy} cardRef={cardRef} />
    {receipt.changes?.appointment && <div className="admin-receipt-warning" role="status">
      <p>This booking was moved after the receipt was made, so the date and time on the receipt are out of date.</p>
      <button className="btn--tonal btn--small" disabled={busy} onClick={updateAppointment}>Update the date and time</button>
    </div>}
    {receipt.changes?.total && <p role="status" className="admin-receipt-warning">The price on this booking is no longer the {money(receipt.snapshot.total)} on this receipt. Check the booking before you send it.</p>}
    <div className="admin-payment-buttons">
      <button className="btn--primary" disabled={busy || !email} onClick={send}>Email to {shortFirst}</button>
      {whatsapp && <a className="btn" href={whatsapp} target="_blank" rel="noopener noreferrer">WhatsApp {shortFirst}</a>}
      <button className="btn--quiet" disabled={busy} onClick={share}>Share or copy</button>
      <PdfButton receipt={receipt} />
    </div>
    {!email && <p className="admin-detail-hint">There is no email address on this booking, so it cannot be emailed.</p>}
    <EmailStatus state={mail} busy={busy} check={check} statusRef={statusRef} />
    {receiptEditedAfterEmail(receipt) && <p role="status" className="admin-receipt-warning">You changed this receipt after you emailed it, so the email has the old words. Press Email to send the new one.</p>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert" className="admin-field-error">{error}</p>}
  </div>
}

// On a booking that was cancelled, whose payment was refunded, or that was marked as missed: if a receipt was made before that,
// say so, so nobody sends it on by hand. It can no longer be sent or changed here.
export function ReceiptNote({ booking, api = receiptsApi }) {
  const [receipt, setReceipt] = useState(null)
  useEffect(() => {
    let current = true
    api.get(booking.id).then(found => { if (current) setReceipt(found) }, () => {})
    return () => { current = false }
  }, [api, booking.id])
  if (!receipt) return null
  const reason = booking.booking_status === 'cancelled' ? 'the booking was cancelled'
    : booking.booking_status === 'no_show' ? 'the appointment was marked as missed' : 'the payment was refunded'
  const mail = receiptEmailState(receipt)
  const sent = mail?.status === 'sent' ? `, and emailed to ${mail.to} on ${shortDay(mail.at)}` : ''
  return <div className="admin-receipt-panel">
    <p className="admin-detail-hint">Receipt {receipt.number} was made for this booking{sent}. Because {reason}, it can no longer be sent or changed. Its PDF says so.</p>
    <div className="admin-payment-buttons"><PdfButton receipt={receipt} /></div>
  </div>
}
