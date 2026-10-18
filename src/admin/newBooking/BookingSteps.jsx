import DayTimePicker from '../../client/booking/components/DayTimePicker.jsx'
import { dateLabel, money, time, shiftDate, today } from '../calendarPresentation.js'
import AllTimes from './AllTimes.jsx'
import PastTimes from './PastTimes.jsx'
import { clientLabel, isPaidArrangement, PAST_PAYMENT_OPTIONS, pastOutcome, PAYMENT_OPTIONS } from './presentation.js'
import { dayName } from '../seriesApi.js'

export function Quote({ quote }) {
  // A fee of £0.00 is not worth a row; the service and the total are always shown.
  return quote ? <dl className="anb-price">{[['Service', quote.service_subtotal_gbp, true], ['Extras', quote.enhancements_total_gbp], ['Travel fee', quote.travel_fee_gbp], ['Congestion fee', quote.congestion_fee_gbp], ['Total', quote.total_gbp, true]].filter(([, amount, always]) => always || Number(amount) > 0).map(([label, amount]) => <div key={label}><dt>{label}</dt><dd>{money(amount)}</dd></div>)}</dl> : null
}

export function DateTimeStep({ draft, patch, duration, loadDay, loadTimes, loadPastTimes, reloadKey }) {
  if (!duration) return <p className="anb-hint">Choose a treatment and a length, and the free times appear here.</p>
  // A usual time is chosen as always. A time from "Show all times" that is not usual is marked, with what is being set aside, and a repeat is switched off
  // for it: the weekly bookings that follow are only ever made at the usual times.
  const pick = (date, start, choice) => patch({ date, start, anyTime: choice.anyTime, anyTimeNotes: choice.notes, ...(choice.anyTime ? { repeat: { ...draft.repeat, on: false } } : {}) })
  // "It has already happened": recording an appointment that took place (a day that has gone can then be chosen). It is never a repeat, so that
  // is switched off here. Turning it off goes back to today, and a "paid" choice made for something that has happened does not carry over to a
  // booking for the future by accident.
  const setPast = on => patch(on
    ? { past: true, date: draft.date < today() ? draft.date : shiftDate(today(), -1), start: null, anyTime: false, anyTimeNotes: [], repeat: { ...draft.repeat, on: false } }
    : { past: false, date: today(), start: null, payment: isPaidArrangement(draft.payment) ? 'bank_pending' : draft.payment })
  return <>
    <label className="anb-radio anb-past-toggle"><input type="checkbox" checked={Boolean(draft.past)} onChange={event => setPast(event.target.checked)} /><span>It has already happened</span></label>
    {!draft.past && <p className="anb-hint">Putting an appointment in the diary after the fact? Tick this to choose a day that has gone.</p>}
    {draft.past
      ? <PastTimes date={draft.date} duration={duration} selectedStart={draft.start} loadTimes={loadPastTimes} reloadKey={reloadKey}
        onPick={(date, start) => patch({ date, start })} onDate={date => patch({ date, start: null })} />
      : <DayTimePicker key={duration} horizonDays={365} initialDate={draft.date} loadDay={loadDay}
        selected={draft.start === null ? null : { date: draft.date, start: draft.start }} onPick={(date, start) => pick(date, start, { anyTime: false, notes: [] })}
        emptyMessage="No available times. Choose another date."
        renderFooter={date => <AllTimes date={date} duration={duration} selectedStart={draft.date === date ? draft.start : null} selectedNotes={draft.anyTime ? draft.anyTimeNotes || [] : []} onPick={pick} loadTimes={loadTimes} reloadKey={reloadKey} />} />}
  </>
}

export function PaymentStep({ draft, patch }) {
  return <><fieldset><legend>Payment arrangement</legend>{(draft.past ? PAST_PAYMENT_OPTIONS : PAYMENT_OPTIONS).map(([value, label]) => <label className="anb-radio" key={value}><input type="radio" name="admin-payment" value={value} checked={draft.payment === value} onChange={() => patch({ payment: value })} /><span>{label}</span></label>)}</fieldset>
    <label>Appointment note (optional)<textarea value={draft.note} maxLength={4000} onChange={event => patch({ note: event.target.value })} /></label><p className="anb-hint">For this appointment only. Saved client preferences are unchanged.</p>
    {draft.start !== null && draft.anyTime && <p className="anb-hint">A repeating booking needs one of the usual times.</p>}
    {draft.start !== null && draft.past && <p className="anb-hint">A repeating booking cannot start with an appointment that has already happened.</p>}
    {draft.start !== null && !draft.anyTime && !draft.past && <fieldset className="anb-repeat"><legend>Repeat</legend>
      <label className="anb-radio"><input type="checkbox" checked={Boolean(draft.repeat?.on)} onChange={event => patch({ repeat: { ...draft.repeat, on: event.target.checked } })} /><span>Repeat every {dayName(draft.date)} at {time(draft.start ?? 0)}</span></label>
      {draft.repeat?.on && <>
        <label>Stop repeating after (optional)<input type="date" min={draft.date} max={shiftDate(draft.date, 1100)} value={draft.repeat.endDate || ''} onChange={event => patch({ repeat: { ...draft.repeat, endDate: event.target.value } })} /></label>
        <p className="anb-hint">This slot is kept free for them every week. Only the next appointment is asked to be paid: about a week before each one it becomes a booking and they get a reminder. Nothing is cancelled for you.</p>
      </>}
    </fieldset>}</>
}

// The whole booking at a glance, just above the Create button.
export function Summary({ draft, catalogue, quote }) {
  const duration = draft.sessions.reduce((sum, session) => sum + session.duration_minutes, 0)
  const service = catalogue.services.find(item => item.id === draft.serviceId)
  const area = catalogue.areas.find(item => item.id === draft.areaId)
  // A day that has gone is shown with its year, so there is no doubt which one is about to be recorded.
  const when = draft.start === null ? 'Choose a time above' : `${dateLabel(draft.date, { weekday: 'short', day: 'numeric', month: 'short', ...(draft.past ? { year: 'numeric' } : {}) })} · ${time(draft.start)}–${time(draft.start + duration)}`
  return <section className="anb-block anb-summary" aria-labelledby="anb-summary-title"><h2 id="anb-summary-title">Summary</h2>
    <p><strong>{draft.client ? clientLabel(draft.client) : 'No client chosen yet'}</strong></p>
    <p>{when}</p>
    {draft.anyTime && draft.start !== null && draft.anyTimeNotes?.length > 0 && <div className="anb-time-note"><p><strong>Outside your usual times</strong></p><ul>{draft.anyTimeNotes.map(note => <li key={note}>{note}</li>)}</ul></div>}
    <p>{duration} min {service?.name || 'treatment to choose'}{area ? ` · ${area.name}` : ''}</p>
    {draft.past
      ? <p className="anb-hint">{(PAST_PAYMENT_OPTIONS.find(([value]) => value === draft.payment) || PAST_PAYMENT_OPTIONS[2])[1]}. {pastOutcome(draft.payment)}</p>
      : <p className="anb-hint">{PAYMENT_OPTIONS.find(([value]) => value === draft.payment)?.[1]}. The appointment will be confirmed.</p>}
    {draft.repeat?.on && <p>Repeats every {dayName(draft.date)}{draft.repeat.endDate ? ` until ${dateLabel(draft.repeat.endDate, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}` : ', with no end date'}. Later appointments use this payment arrangement ({draft.payment.startsWith('cash') ? 'cash' : 'bank transfer'}).</p>}
    <Quote quote={quote} />
  </section>
}
