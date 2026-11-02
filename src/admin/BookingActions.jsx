import { useCallback, useEffect, useRef, useState } from 'react'
import { DONE, feeChoices, lifecycleActions, lifecycleApi, lifecycleLabels } from './bookingLifecycleApi.js'
import { clientName, dateLabel, label, money, time, today } from './calendarPresentation.js'
import { acquireBodyScrollLock } from './dialogScrollLock.js'
import { toast } from '../ui/toast.js'
import { cancelOutcome, REFUND_HINT } from './cancelOutcome.js'
import DayTimePicker from '../client/booking/components/DayTimePicker.jsx'
import AllTimes from './newBooking/AllTimes.jsx'

const ACTION_STYLE = { complete: 'btn--primary', feeReceived: 'btn--primary', refund: 'btn--primary', cancel: 'btn--danger', feeWaive: 'btn--quiet', noShow: '', reschedule: '' }

const WHO = [['client', 'The client asked'], ['admin', 'It is my own decision']]
const explanations = {
  complete: 'Mark this appointment as completed.',
  noShow: 'The client did not attend. The full price is recorded as a late fee unless you change it.',
  refund: 'Confirm that you have sent the refund. This records the payment as refunded, and the reminder goes.',
  feeReceived: 'Confirm that the late fee has been paid.',
  feeWaive: 'The client will not be charged the late fee. The standard amount stays on record.',
}

function Who({ value, onChange, disabled }) {
  return <fieldset className="admin-who"><legend>Who is asking?</legend>
    {WHO.map(([key, text]) => <label key={key}><input type="radio" name="initiated-by" checked={value === key} disabled={disabled} onChange={() => onChange(key)} /> {text}</label>)}
  </fieldset>
}


// One question about one booking, with what it will do. It is used on the booking sheet, and for Record refund on a cancelled card in the Calendar.
export function ActionDialog({ kind, booking, api, close, done }) {
  const ref = useRef(null)
  const request = useRef(null)
  // Set when she picks or types a fee, so a standard fee that arrives later never replaces it.
  const feeTouched = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [initiatedBy, setInitiatedBy] = useState('client')
  const [reason, setReason] = useState('')
  const [fee, setFee] = useState('')
  const [standardFee, setStandardFee] = useState(null)
  // Whether the standard fee has been looked up: loading, ok or failed.
  const [lookup, setLookup] = useState('loading')
  // The time chosen for a move: usual, or one from "Show all times" (anyTime) with what is being set aside (notes).
  const [slot, setSlot] = useState(null)
  // Raised after a refusal, so the times on show are asked for again.
  const [reloadKey, setReloadKey] = useState(0)
  // All the times of a day, with the booking being moved left out so it is never in its own way.
  const loadTimes = useCallback((date, minutes) => api.times(date, minutes, booking.id), [api, booking.id])
  const total = Number(booking.total_gbp)

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
    api.preview(booking.id, initiatedBy, kind).then(value => {
      if (!live) return
      setStandardFee(value)
      setLookup('ok')
      // The standard fee is only where she starts: it never replaces a fee she has already chosen.
      if (kind === 'cancel' && !feeTouched.current) setFee(String(value))
    }, () => { if (live) { setStandardFee(null); setLookup('failed') } })
    return () => { live = false }
  }, [api, booking.id, kind, initiatedBy])

  // Who is asking changes the standard fee, so it is looked up again; until it arrives no fee is chosen, so nothing old is carried over.
  function changeWho(value) {
    setInitiatedBy(value)
    setStandardFee(null)
    setLookup('loading')
    feeTouched.current = false
    if (kind === 'cancel') setFee('')
  }
  function chooseFee(text) { feeTouched.current = true; setFee(text) }

  function input() {
    if (kind === 'cancel') return { reason: reason.trim() || null, initiatedBy, fee: fee === '' ? null : Number(fee) }
    if (kind === 'noShow') return { fee: fee === '' ? null : Number(fee) }
    if (kind === 'reschedule') return { date: slot.date, start: slot.start, initiatedBy, anyTime: slot.anyTime }
    return {}
  }
  const feeValid = fee === '' || (Number(fee) >= 0 && Number(fee) <= total)
  // A cancellation never goes ahead on a fee she has not seen: either the standard fee has arrived or she chose one.
  // A change she makes for the client, inside the free window, records a late fee. She is not let go on before she has been told what it is,
  // or told that it could not be checked.
  const feeAtStake = kind === 'reschedule' && initiatedBy === 'client' && booking.late_fee_status === 'none'
  const ready = (kind !== 'cancel' || (feeValid && fee !== '')) && (kind !== 'noShow' || feeValid) && (kind !== 'reschedule' || (Boolean(slot) && !(feeAtStake && lookup === 'loading')))

  async function submit(event) {
    event.preventDefault()
    if (busy || !ready) return
    setBusy(true); setError('')
    const payload = input()
    const key = JSON.stringify([kind, booking.updated_at, payload])
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    try {
      await api.act(kind, booking, request.current.id, payload)
      await done(`${DONE[kind] || 'Saved'}.`)
    } catch (failure) {
      setError(failure.message)
      if (kind === 'reschedule') setReloadKey(value => value + 1)
      if (failure.conflict) await done(failure.message, true)
    } finally { setBusy(false) }
  }

  const choices = feeChoices(kind, total, standardFee)
  // A no-show with nothing typed means the full price.
  const shownFee = fee === '' ? (kind === 'noShow' ? total : null) : Number(fee)
  // What happens to the money, in plain words, for the fee chosen: said before she confirms, so a refund to send is never a surprise.
  const outcome = kind === 'cancel' && feeValid && fee !== '' ? cancelOutcome(booking, fee) : null
  const lateFeeNote = feeAtStake && standardFee > 0
    ? `A late fee of ${money(standardFee)} will be recorded as due, because this change is inside the free cancellation window.` : ''
  const lateFeeWait = feeAtStake && lookup === 'loading' && slot ? 'Checking whether a late fee applies…' : ''
  const lateFeeUnknown = feeAtStake && lookup === 'failed'
    ? "I couldn't check whether a late fee applies. If this change is inside the free cancellation window, a fee may be recorded, unless it is your own decision." : ''

  return <dialog ref={ref} className="admin-confirm admin-action" aria-labelledby="booking-action-title" onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) close() }}>
    <form onSubmit={submit}>
      <h2 id="booking-action-title">{lifecycleLabels[kind]}?</h2>
      <div className="admin-confirm-summary"><strong>{clientName(booking)}</strong><span>{dateLabel(booking.date)} · {time(booking.start_minutes)}</span><b className="figure">{money(booking.total_gbp)}</b></div>
      {explanations[kind] && <p>{explanations[kind]}</p>}

      {(kind === 'cancel' || kind === 'reschedule') && <Who value={initiatedBy} onChange={changeWho} disabled={busy} />}
      {kind === 'reschedule' && <>
        {/* The usual times as ever. "Show all times" is the same button as on New booking, for the others: a shorter gap, an evening, a day off,
            or the only booking of a day that starts at a set time (set aside to be moved, that day looks empty and offers just that time). */}
        <DayTimePicker horizonDays={365} dateLabel="New date" initialDate={booking.date >= today() ? booking.date : today()} reloadKey={reloadKey}
          loadDay={date => api.availability(date, booking.treatment_duration_minutes, booking.id)}
          selected={slot} onPick={(date, start) => { setSlot({ date, start, anyTime: false, notes: [] }); setError('') }} emptyMessage="No available times. Choose another date."
          renderFooter={date => <AllTimes date={date} duration={booking.treatment_duration_minutes} selectedStart={slot?.date === date ? slot.start : null}
            selectedNotes={slot?.anyTime ? slot.notes : []} onPick={(day, start, choice) => { setSlot({ date: day, start, ...choice }); setError('') }}
            loadTimes={loadTimes} reloadKey={reloadKey} />} />
        {/* What is being set aside is said under the times, where she tapped; here, beside the button that confirms, it is only a reminder. */}
        {slot && <p className="admin-new-time" role="status">New time: {dateLabel(slot.date, { weekday: 'short', day: 'numeric', month: 'short' })} · {time(slot.start)}{slot.anyTime && ' · outside your usual times'}</p>}
        {lateFeeNote && <p role="status">{lateFeeNote}</p>}
        {lateFeeWait && <p className="admin-detail-hint" role="status">{lateFeeWait}</p>}
        {lateFeeUnknown && <p role="status">{lateFeeUnknown}</p>}
      </>}
      {choices.length > 0 && <>
        <fieldset className="admin-who admin-fee-choices" style={{ '--choices': choices.length }}><legend>Late fee</legend>
          {choices.map(choice => <label key={choice.value}><input type="radio" name="fee-choice" checked={shownFee === choice.value} disabled={busy} onChange={() => chooseFee(String(choice.value))} /> {choice.text}</label>)}
        </fieldset>
        {kind === 'cancel' && fee === '' && <p className="admin-detail-hint" role="status">{lookup === 'failed' ? "I couldn't look up the usual fee. Please choose one above." : 'Looking up the usual fee…'}</p>}
        <label className="admin-field">Another amount (£)
          <input type="number" inputMode="decimal" min="0" max={total} step="0.01" value={fee} disabled={busy} onChange={event => chooseFee(event.target.value)} />
          <span className="admin-detail-hint">{kind === 'cancel' && standardFee !== null ? `Standard fee now: ${money(standardFee)}. ` : ''}Up to {money(total)}.</span>
        </label>
      </>}
      {outcome && <div className="admin-money-outcome" role="status"><span>What happens to the money</span><strong>{outcome.text}</strong>{outcome.refund > 0 && <small>{REFUND_HINT}</small>}</div>}
      {kind === 'cancel' && <label className="admin-field">Reason (optional, kept in the booking history)<textarea maxLength={500} rows={2} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></label>}

      {error && <p role="alert">{error}</p>}
      <div className={`admin-payment-buttons ${kind === 'cancel' || kind === 'reschedule' ? 'admin-sticky-actions' : ''}`}>
        <button type="submit" className={kind === 'cancel' ? 'btn--danger-solid' : 'btn--primary'} disabled={busy || !ready}>{busy ? 'Saving…' : kind === 'cancel' && Number(fee) > 0 ? `${lifecycleLabels[kind]} · ${booking.booking_payments?.status === 'paid' ? `you keep ${money(Math.min(Number(fee), Number(booking.booking_payments.amount_gbp)))}` : `${money(fee)} fee due`}` : lifecycleLabels[kind]}</button>
        <button type="button" className="btn--quiet" disabled={busy} onClick={close}>Go back</button>
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
    if (!isError) toast(`${DONE[kind] || 'Saved'} · ${clientName(booking)}`)
    try { await refresh() } catch { setMessage({ error: true, text: 'The booking changed. Could not refresh its status; please refresh before another action.' }) }
  }
  const owed = []
  if (Number(booking.late_fee_due_gbp) > 0 || booking.late_fee_status === 'waived') owed.push(`Late fee: ${label(booking.late_fee_status)}${Number(booking.late_fee_due_gbp) > 0 ? ` · ${money(booking.late_fee_due_gbp)}` : ''}`)
  if (Number(booking.refund_due_gbp) > 0) owed.push(`Refund due: ${money(booking.refund_due_gbp)}`)
  return <div className="admin-booking-actions">
    {owed.length > 0 && <ul role="list" className="admin-owed">{owed.map(line => <li key={line}>{line}</li>)}</ul>}
    {actions.length > 0 && <div className="admin-payment-buttons">{actions.map(action => <button key={action} className={ACTION_STYLE[action]} onClick={() => { setMessage(null); setKind(action) }}>{lifecycleLabels[action]}</button>)}</div>}
    {message && <p role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    {kind && <ActionDialog key={kind} kind={kind} booking={booking} api={api} close={() => setKind(null)} done={done} />}
    <History booking={booking} api={api} />
  </div>
}
