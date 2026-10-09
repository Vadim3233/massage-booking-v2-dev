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

export function ReviewStep({ draft, catalogue, quote }) {
  const duration = draft.sessions.reduce((sum, session) => sum + session.duration_minutes, 0)
  return <><section className="anb-review-summary"><h3>{clientLabel(draft.client)}</h3><p>{dateLabel(draft.date, { weekday: 'short', day: 'numeric', month: 'short' })} · {time(draft.start)}–{time(draft.start + duration)}</p><p>{duration} min {catalogue.services.find(item => item.id === draft.serviceId)?.name}</p><address>{[draft.details.address_line_1, draft.details.address_line_2, draft.details.city, draft.details.postcode].filter(Boolean).join(', ')}</address>{draft.details.entry_instructions && <p>{draft.details.entry_instructions}</p>}</section>
    <section className="anb-section"><h3>Sessions</h3>{draft.sessions.map((session, index) => <div className="anb-review-session" key={index}><strong>{index + 1}. {session.recipient_name} · {session.duration_minutes} min</strong><p>{catalogue.preferences.filter(item => session.preference_ids.includes(item.id)).map(item => item.label).join(', ') || 'No session preferences'}</p></div>)}<p>Enhancements: {catalogue.enhancements.filter(item => draft.enhancementIds.includes(item.id)).map(item => item.name).join(', ') || 'None'}</p><p className="anb-hint">{duration} minutes treatment · 60-minute travel buffer around the visit, not between sessions.</p><p>Service area: {catalogue.areas.find(item => item.id === draft.areaId)?.name}</p></section>
    <Quote quote={quote} /><section className="anb-section"><h3>Payment</h3><p>{PAYMENT_OPTIONS.find(([value]) => value === draft.payment)?.[1]}</p><p className="anb-hint">The appointment will be confirmed.</p>{draft.repeat?.on && <p>Repeats every {dayName(draft.date)}{draft.repeat.endDate ? ` until ${dateLabel(draft.repeat.endDate, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}` : ', with no end date'}. Later appointments use this payment arrangement ({draft.payment.startsWith('cash') ? 'cash' : 'bank transfer'}).</p>}{draft.note && <><h3>Appointment note</h3><p className="anb-note">{draft.note}</p></>}</section>
  </>
}
