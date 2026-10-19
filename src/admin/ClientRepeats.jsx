import { useEffect, useState } from 'react'
import { CANCELLABLE, canPutBack, describeRepeat, seriesApi, SKIP_LABELS } from './seriesApi.js'
import { dateLabel, label, today } from './calendarPresentation.js'

const day = date => dateLabel(date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
const STATUS_TEXT = { active: 'Repeating', paused: 'Paused', ended: 'Ended' }
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`
// The first dates of a repeat are shown at once; the rest of the next twelve are one tap away, so the page does not run on.
const FIRST_ROWS = 6

// What a date in "Coming up" is: booked (and how far along), only being kept free for them, paused, or not booked (and why).
function stateText(item) {
  if (item.state === 'booked') return `Booked · ${label(item.booking_status)}`
  if (item.state === 'held') return 'Kept free for them'
  if (item.state === 'paused') return 'Paused'
  return SKIP_LABELS[item.reason] || 'Not booked'
}
// A date can be ticked for cancelling when it is a booking that can still be cancelled, or a date that is only being kept free.
const pickable = (item, series) => series.status !== 'ended' && (item.state === 'held' || (item.state === 'booked' && CANCELLABLE.includes(item.booking_status)))
// What cancelling a booking does, said before it is done.
const cancelling = count => `${plural(count, 'booking', 'bookings')} will be cancelled, and the client is emailed about ${count === 1 ? 'it' : 'each'}. No late fee is charged, and anything they have paid becomes a refund for you to send.`

// A client's repeating bookings: see what is coming, cancel some dates or everything still to come, skip a date, pause, or stop.
// Booked sessions are otherwise changed like any booking.
export default function ClientRepeats({ clientId, openBooking, api = seriesApi }) {
  const [list, setList] = useState(null)
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(null)
  const [picked, setPicked] = useState({})
  const [expanded, setExpanded] = useState({})
  const [skipDate, setSkipDate] = useState({})
  useEffect(() => {
    let live = true
    api.list(clientId).then(rows => { if (live) { setList(rows); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, clientId, version])
  async function act(work) {
    if (busy) return
    setBusy(true); setError('')
    try { await work(); setAsking(null); setPicked({}); setVersion(value => value + 1) } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  const pickedFor = id => picked[id] || []
  const toggle = (id, date) => setPicked(current => ({ ...current, [id]: (current[id] || []).includes(date) ? current[id].filter(item => item !== date) : [...(current[id] || []), date].sort() }))
  if (list && !list.length && !error) return null
  return <section aria-labelledby="repeats-title"><h2 id="repeats-title">Repeating bookings</h2>
    {error && <p role="alert">{error}</p>}
    {!list && !error && <p role="status">Loading repeating bookings…</p>}
    {list?.map(series => {
      const upcoming = series.upcoming || []
      const rows = expanded[series.id] ? upcoming : upcoming.slice(0, FIRST_ROWS)
      const shown = new Set(rows.map(item => item.date))
      const others = (series.skipped || []).filter(item => !shown.has(item.date))
      const chosen = pickedFor(series.id)
      const chosenItems = upcoming.filter(item => chosen.includes(item.date))
      const bookedChosen = chosenItems.filter(item => item.state === 'booked').length
      const heldChosen = chosenItems.length - bookedChosen
      const mine = asking?.id === series.id ? asking.what : null
      return <article key={series.id} className="admin-repeat">
        <h3>{describeRepeat(series)}</h3>
        <p className="admin-detail-hint">{STATUS_TEXT[series.status]}{series.pattern === 'dates' ? '' : series.end_date ? ` · until ${day(series.end_date)}` : ' · no end date'} · {series.payment_arrangement === 'cash_appointment' ? 'cash' : 'bank transfer'}</p>
        {series.next_booking && <p>Next booking: <button className="admin-link-button" onClick={() => openBooking(series.next_booking.id)}>{day(series.next_booking.date)} · {label(series.next_booking.booking_status)}</button></p>}
        {!series.next_booking && series.next_held_date && <p>Next session: {day(series.next_held_date)} (booked closer to the day, when payment is asked for)</p>}
        {upcoming.length > 0 && <fieldset className="admin-repeat-dates"><legend>Coming up</legend>
          <ul role="list">{rows.map(item => <li key={item.date}>
            {pickable(item, series)
              ? <label><input type="checkbox" checked={chosen.includes(item.date)} disabled={busy} onChange={() => toggle(series.id, item.date)} /><span><strong>{day(item.date)}</strong><small>{stateText(item)}</small></span></label>
              : <div><strong>{day(item.date)}</strong><small>{stateText(item)}</small></div>}
            {item.state === 'booked' && <button type="button" className="admin-link-button" aria-label={`Open the booking on ${day(item.date)}`} onClick={() => openBooking(item.booking_id)}>Open</button>}
            {item.state === 'skipped' && canPutBack(item.reason) && series.status === 'active' && <button type="button" className="btn--small" disabled={busy} aria-label={`Put back ${day(item.date)}`} onClick={() => act(() => api.unskip(series.id, item.date))}>Put back</button>}
          </li>)}</ul>
          {rows.length < upcoming.length && <button type="button" className="btn--quiet btn--small" onClick={() => setExpanded({ ...expanded, [series.id]: true })}>Show the other {upcoming.length - rows.length} dates</button>}
        </fieldset>}
        {others.length > 0 && <ul role="list" className="admin-special-list" aria-label="Dates not booked">{others.map(item => <li key={item.date}>
          <div><strong>{day(item.date)}</strong><span>{SKIP_LABELS[item.reason]}</span></div>
          {canPutBack(item.reason) && series.status === 'active' && <div className="admin-payment-buttons"><button className="btn--small" disabled={busy} onClick={() => act(() => api.unskip(series.id, item.date))}>Put back</button></div>}
        </li>)}</ul>}
        {series.status !== 'ended' && <>
          {mine === 'dates'
            ? <div role="alert" className="admin-conflicts"><p>Cancel {plural(chosenItems.length, 'date', 'dates')}?{bookedChosen > 0 && ` ${cancelling(bookedChosen)}`}{heldChosen > 0 && ` The ${heldChosen === 1 ? 'date that is' : `${heldChosen} dates that are`} only being kept free will be released.`}</p>
                <div className="admin-payment-buttons"><button disabled={busy} onClick={() => setAsking(null)}>Keep {chosenItems.length === 1 ? 'it' : 'them'}</button><button className="btn--danger-solid" disabled={busy} onClick={() => act(() => api.cancelDates(series.id, chosen))}>Yes, cancel {chosenItems.length === 1 ? 'it' : 'them'}</button></div></div>
            : upcoming.some(item => pickable(item, series)) && <div className="admin-payment-buttons"><button type="button" className="btn--small btn--danger" disabled={busy || !chosen.length} onClick={() => setAsking({ id: series.id, what: 'dates' })}>{chosen.length ? `Cancel ${plural(chosen.length, 'selected date', 'selected dates')}` : 'Cancel selected dates'}</button></div>}
          <form className="admin-repeat-skip" onSubmit={event => { event.preventDefault(); if (skipDate[series.id]) act(() => api.skip(series.id, skipDate[series.id]).then(() => setSkipDate({ ...skipDate, [series.id]: '' }))) }}>
            <label className="admin-field">Skip a date<input type="date" min={today()} value={skipDate[series.id] || ''} disabled={busy} onChange={event => setSkipDate({ ...skipDate, [series.id]: event.target.value })} /></label>
            <button type="submit" className="btn--tonal btn--small" disabled={busy || !skipDate[series.id]}>Skip this date</button>
          </form>
          {mine === 'stop'
            ? <div role="alert" className="admin-conflicts"><p>Stop this repeat? The times being kept free are released. Bookings already made stay until you cancel them.</p>
                <div className="admin-payment-buttons"><button disabled={busy} onClick={() => setAsking(null)}>Keep it</button><button className="btn--danger-solid" disabled={busy} onClick={() => act(() => api.setStatus(series.id, 'ended'))}>Yes, stop repeating</button></div></div>
            : mine === 'all'
              ? <div role="alert" className="admin-conflicts"><p>Cancel everything still to come, and stop this repeat? {series.upcoming_booked > 0 ? cancelling(series.upcoming_booked) : 'No bookings are waiting yet, only the times being kept free.'} The times being kept free are released. Sessions that have already happened stay as they are.</p>
                  <div className="admin-payment-buttons"><button disabled={busy} onClick={() => setAsking(null)}>Keep it</button><button className="btn--danger-solid" disabled={busy} onClick={() => act(() => api.cancelAllUpcoming(series.id))}>Yes, cancel all upcoming</button></div></div>
              : <div className="admin-payment-buttons">
                  <button className="btn--small" disabled={busy} onClick={() => act(() => api.setStatus(series.id, series.status === 'active' ? 'paused' : 'active'))}>{series.status === 'active' ? 'Pause' : 'Resume'}</button>
                  <button className="btn--small btn--danger" disabled={busy} onClick={() => setAsking({ id: series.id, what: 'stop' })}>Stop repeating</button>
                  <button className="btn--small btn--danger" disabled={busy} onClick={() => setAsking({ id: series.id, what: 'all' })}>Cancel all upcoming</button>
                </div>}
        </>}
      </article>
    })}
    <p className="admin-detail-hint">The time is kept free for this client on every date of the repeat. About a week before each session it becomes a booking and they are asked to pay for it.</p>
  </section>
}
