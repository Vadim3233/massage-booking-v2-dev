import { useEffect, useRef, useState } from 'react'
import { lifecycleActions, lifecycleApi, lifecycleLabels } from './bookingLifecycleApi.js'
import { clientName, dateLabel, label, money, time, today } from './calendarPresentation.js'
import { acquireBodyScrollLock } from './dialogScrollLock.js'

const WHO = [['client', 'The client asked'], ['admin', 'It is my own decision']]
const explanations = {
  complete: 'Mark this appointment as completed.',
  noShow: 'The client did not attend. The full price is recorded as a late fee unless you change it.',
  refund: 'Confirm that you have sent the refund. This records the payment as refunded.',
  feeReceived: 'Confirm that the late fee has been paid.',
  feeWaive: 'The client will not be charged the late fee. The standard amount stays on record.',
}

function Who({ value, onChange, disabled }) {
  return <fieldset className="admin-who"><legend>Who is asking?</legend>
    {WHO.map(([key, text]) => <label key={key}><input type="radio" name="initiated-by" checked={value === key} disabled={disabled} onChange={() => onChange(key)} /> {text}</label>)}
  </fieldset>
}

function ActionDialog({ kind, booking, api, close, done }) {
  const ref = useRef(null)
  const request = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [initiatedBy, setInitiatedBy] = useState('client')
  const [reason, setReason] = useState('')
  const [fee, setFee] = useState('')
  const [standardFee, setStandardFee] = useState(null)
  const [date, setDate] = useState(booking.date >= today() ? booking.date : today())
  const [times, setTimes] = useState(null)
  const [start, setStart] = useState('')
  const total = Number(booking.total_gbp)
  const takesFee = kind === 'cancel' || kind === 'reschedule' || kind === 'noShow'

  useEffect(() => {
    const dialog = ref.current
    const opener = document.activeElement
    dialog.showModal()
    const release = acquireBodyScrollLock()
    return () => { if (dialog.open) dialog.close(); release(); opener?.focus({ preventScroll: true }) }
  }, [])

  useEffect(() => {
    if (kind !== 'cancel' && kind !== 'reschedule') return undefined
    let live = true
    api.preview(booking.id, initiatedBy).then(value => {
      if (!live) return
      setStandardFee(value)
      if (kind === 'cancel') setFee(String(value))
    }, () => { if (live) setStandardFee(null) })
    return () => { live = false }
  }, [api, booking.id, kind, initiatedBy])

  useEffect(() => {
    if (kind !== 'reschedule' || !date) return undefined
    let live = true
    api.availability(date, booking.treatment_duration_minutes, booking.id).then(list => { if (live) { setTimes(list); setStart('') } }, failure => { if (live) { setTimes([]); setError(failure.message) } })
    return () => { live = false }
  }, [api, kind, date, booking.id, booking.treatment_duration_minutes])

  function input() {
    if (kind === 'cancel') return { reason, initiatedBy, fee: fee === '' ? null : Number(fee) }
    if (kind === 'noShow') return { fee: fee === '' ? null : Number(fee) }
    if (kind === 'reschedule') return { date, start: Number(start), initiatedBy }
    return {}
  }
  const feeValid = fee === '' || (Number(fee) >= 0 && Number(fee) <= total)
  const ready = (kind !== 'cancel' || (reason.trim() && feeValid)) && (kind !== 'noShow' || feeValid) && (kind !== 'reschedule' || (date && start !== ''))

  async function submit(event) {
    event.preventDefault()
    if (busy || !ready) return
    setBusy(true); setError('')
    const payload = input()
    const key = JSON.stringify([kind, booking.updated_at, payload])
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    try {
      await api.act(kind, booking, request.current.id, payload)
      await done('Saved. Refreshing current status.')
    } catch (failure) {
      setError(failure.message)
      if (failure.conflict) await done(failure.message, true)
    } finally { setBusy(false) }
  }

  const refundNote = kind === 'cancel' && booking.booking_payments?.status === 'paid' && feeValid
    ? `Payment of ${money(booking.booking_payments.amount_gbp)} has been received. ${money(Math.max(Number(booking.booking_payments.amount_gbp) - Number(fee || 0), 0))} will be recorded as a refund due.` : ''
  const lateFeeNote = kind === 'reschedule' && initiatedBy === 'client' && booking.late_fee_status === 'none' && standardFee > 0
    ? `A late fee of ${money(standardFee)} will be recorded as due, because this change is inside the free cancellation window.` : ''

  return <dialog ref={ref} className="admin-confirm admin-action" aria-labelledby="booking-action-title" onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) close() }}>
    <form onSubmit={submit}>
      <h2 id="booking-action-title">{lifecycleLabels[kind]}?</h2>
      <p><strong>{clientName(booking)}</strong></p>
      <p>{dateLabel(booking.date)} · {time(booking.start_minutes)} · {money(booking.total_gbp)}</p>
      {explanations[kind] && <p>{explanations[kind]}</p>}

      {kind === 'cancel' && <>
        <Who value={initiatedBy} onChange={setInitiatedBy} disabled={busy} />
        <label className="admin-field">Reason<textarea required maxLength={500} rows={3} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
      </>}
      {kind === 'reschedule' && <>
        <Who value={initiatedBy} onChange={setInitiatedBy} disabled={busy} />
        <label className="admin-field">New date<input type="date" required min={today()} value={date} disabled={busy} onChange={event => setDate(event.target.value)} /></label>
        <label className="admin-field">New time
          <select required value={start} disabled={busy || !times?.length} onChange={event => setStart(event.target.value)}>
            <option value="">{times === null ? 'Loading times…' : times.length ? 'Choose a time' : 'No times available'}</option>
            {(times || []).map(minutes => <option key={minutes} value={minutes}>{time(minutes)}</option>)}
          </select>
        </label>
        {lateFeeNote && <p role="status">{lateFeeNote}</p>}
      </>}
      {takesFee && kind !== 'reschedule' && <label className="admin-field">Late fee (£)
        <input type="number" inputMode="decimal" min="0" max={total} step="0.01" value={fee} disabled={busy} onChange={event => setFee(event.target.value)} />
        <span className="admin-detail-hint">{kind === 'cancel' && standardFee !== null ? `Standard fee now: ${money(standardFee)}. ` : ''}Enter 0 to waive. Up to {money(total)}.</span>
      </label>}
      {refundNote && <p role="status">{refundNote}</p>}

      {error && <p role="alert">{error}</p>}
      <div className="admin-payment-buttons">
        <button type="button" disabled={busy} onClick={close}>Go back</button>
        <button type="submit" disabled={busy || !ready}>{busy ? 'Saving…' : lifecycleLabels[kind]}</button>
      </div>
    </form>
  </dialog>
}

function History({ booking, api }) {
  const [events, setEvents] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    api.history(booking.id).then(list => { if (live) { setEvents(list); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, booking.id, booking.updated_at, booking.booking_payments?.updated_at])
  const when = value => new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const text = event => event.kind === 'schedule'
    ? `Moved from ${event.from_date} ${time(event.from_start_minutes)} to ${event.to_date} ${time(event.to_start_minutes)}`
    : `${event.kind === 'payment' ? 'Payment' : 'Booking'}: ${event.from_status ? `${label(event.from_status)} → ` : ''}${label(event.to_status)}`
  return <details className="admin-history"><summary>History</summary>
    {error && <p role="alert">{error}</p>}
    {!events && !error && <p role="status">Loading history…</p>}
    {events && !events.length && <p>No recorded changes yet.</p>}
    {events && <ol>{events.map((event, index) => <li key={index}><span>{when(event.occurred_at)}</span> {text(event)} <span className="admin-detail-hint">({label(event.actor_type)})</span></li>)}</ol>}
  </details>
}

export default function BookingActions({ booking, refresh, api = lifecycleApi }) {
  const [kind, setKind] = useState(null)
  const [message, setMessage] = useState(null)
  const actions = lifecycleActions(booking)
  async function done(text, isError = false) {
    setKind(null)
    setMessage({ text, error: isError })
    try { await refresh() } catch { setMessage({ error: true, text: 'The booking changed. Could not refresh its status; please refresh before another action.' }) }
  }
  const owed = []
  if (Number(booking.late_fee_due_gbp) > 0 || booking.late_fee_status === 'waived') owed.push(`Late fee: ${label(booking.late_fee_status)}${Number(booking.late_fee_due_gbp) > 0 ? ` · ${money(booking.late_fee_due_gbp)}` : ''}`)
  if (Number(booking.refund_due_gbp) > 0) owed.push(`Refund due: ${money(booking.refund_due_gbp)}`)
  return <div className="admin-booking-actions">
    {owed.length > 0 && <ul className="admin-owed">{owed.map(line => <li key={line}>{line}</li>)}</ul>}
    {actions.length > 0 && <div className="admin-payment-buttons">{actions.map(action => <button key={action} onClick={() => { setMessage(null); setKind(action) }}>{lifecycleLabels[action]}</button>)}</div>}
    {message && <p role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    {kind && <ActionDialog key={kind} kind={kind} booking={booking} api={api} close={() => setKind(null)} done={done} />}
    <History booking={booking} api={api} />
  </div>
}
