import { dateLabel, money, time, today, shiftDate } from '../calendarPresentation.js'
import { clientLabel, PAYMENT_OPTIONS } from './presentation.js'
import { dayName } from '../seriesApi.js'

export function Quote({ quote }) {
  return quote ? <dl className="anb-price">{[['Service', quote.service_subtotal_gbp], ['Enhancements', quote.enhancements_total_gbp], ['Travel fee', quote.travel_fee_gbp], ['Congestion fee', quote.congestion_fee_gbp], ['Total', quote.total_gbp]].map(([label, amount]) => <div key={label}><dt>{label}</dt><dd>{money(amount)}</dd></div>)}</dl> : null
}

export function DateTimeStep({ draft, patch, availability, loading, error, retry }) {
  return <><label>Appointment date<input type="date" required min={today()} max={shiftDate(today(), 365)} value={draft.date} onChange={event => patch({ date: event.target.value, start: null })} /></label><p className="anb-hint">London time. Availability is checked again when you create the booking.</p>
    {loading && <p role="status">Loading available times…</p>}{error && <><p role="alert">{error}</p><button type="button" onClick={retry}>Retry availability</button></>}
    <div className="anb-slots" role="group" aria-label="Available times">{availability.map(slot => <button key={slot.start_minutes} type="button" aria-pressed={draft.start === slot.start_minutes} disabled={loading} onClick={() => patch({ start: slot.start_minutes })}>{time(slot.start_minutes)}</button>)}</div>
    {!loading && !error && !availability.length && <p>No available times. Choose another date.</p>}
  </>
}

export function PaymentStep({ draft, patch }) {
  return <><fieldset><legend>Payment arrangement</legend>{PAYMENT_OPTIONS.map(([value, label]) => <label className="anb-radio" key={value}><input type="radio" name="admin-payment" value={value} checked={draft.payment === value} onChange={() => patch({ payment: value })} /><span>{label}</span></label>)}</fieldset>
    <label>Appointment note (optional)<textarea value={draft.note} maxLength={4000} onChange={event => patch({ note: event.target.value })} /></label><p className="anb-hint">For this appointment only. Saved client preferences are unchanged.</p>
    <fieldset className="anb-repeat"><legend>Repeat</legend>
      <label className="anb-radio"><input type="checkbox" checked={Boolean(draft.repeat?.on)} onChange={event => patch({ repeat: { ...draft.repeat, on: event.target.checked } })} /><span>Repeat every {dayName(draft.date)} at {time(draft.start ?? 0)}</span></label>
      {draft.repeat?.on && <>
        <label>Stop repeating after (optional)<input type="date" min={draft.date} max={shiftDate(draft.date, 1100)} value={draft.repeat.endDate || ''} onChange={event => patch({ repeat: { ...draft.repeat, endDate: event.target.value } })} /></label>
        <p className="anb-hint">This slot is kept free for them every week. Only the next appointment is asked to be paid: about a week before each one it becomes a booking and they get a reminder. Nothing is cancelled for you.</p>
      </>}
    </fieldset></>
}

// The whole booking at a glance, just above the Create button.
export function Summary({ draft, catalogue, quote }) {
  const duration = draft.sessions.reduce((sum, session) => sum + session.duration_minutes, 0)
  const service = catalogue.services.find(item => item.id === draft.serviceId)
  const area = catalogue.areas.find(item => item.id === draft.areaId)
  const when = draft.start === null ? 'Choose a time above' : `${dateLabel(draft.date, { weekday: 'short', day: 'numeric', month: 'short' })} · ${time(draft.start)}–${time(draft.start + duration)}`
  return <section className="anb-block anb-summary" aria-labelledby="anb-summary-title"><h2 id="anb-summary-title">Summary</h2>
    <p><strong>{draft.client ? clientLabel(draft.client) : 'No client chosen yet'}</strong></p>
    <p>{when}</p>
    <p>{duration} min {service?.name || 'treatment to choose'}{area ? ` · ${area.name}` : ''}</p>
    <p className="anb-hint">{PAYMENT_OPTIONS.find(([value]) => value === draft.payment)?.[1]}. The appointment will be confirmed.</p>
    {draft.repeat?.on && <p>Repeats every {dayName(draft.date)}{draft.repeat.endDate ? ` until ${dateLabel(draft.repeat.endDate, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}` : ', with no end date'}. Later appointments use this payment arrangement ({draft.payment.startsWith('cash') ? 'cash' : 'bank transfer'}).</p>}
    <Quote quote={quote} />
  </section>
}
