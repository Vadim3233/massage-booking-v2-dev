import { useEffect, useState } from 'react'
import { canPutBack, describeRepeat, seriesApi, SKIP_LABELS } from './seriesApi.js'
import { dateLabel, label, today } from './calendarPresentation.js'

const day = date => dateLabel(date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
const STATUS_TEXT = { active: 'Repeating', paused: 'Paused', ended: 'Ended' }

// A client's repeating bookings: see what is coming, skip a date, pause, or stop. Booked sessions are changed like any booking.
export default function ClientRepeats({ clientId, openBooking, api = seriesApi }) {
  const [list, setList] = useState(null)
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(null)
  const [skipDate, setSkipDate] = useState({})
  useEffect(() => {
    let live = true
    api.list(clientId).then(rows => { if (live) { setList(rows); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, clientId, version])
  async function act(work) {
    if (busy) return
    setBusy(true); setError('')
    try { await work(); setStopping(null); setVersion(value => value + 1) } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  if (list && !list.length && !error) return null
  return <section aria-labelledby="repeats-title"><h2 id="repeats-title">Repeating bookings</h2>
    {error && <p role="alert">{error}</p>}
    {!list && !error && <p role="status">Loading repeating bookings…</p>}
    {list?.map(series => <article key={series.id} className="admin-repeat">
      <h3>{describeRepeat(series)}</h3>
      <p className="admin-detail-hint">{STATUS_TEXT[series.status]}{series.end_date ? ` · until ${day(series.end_date)}` : ' · no end date'} · {series.payment_arrangement === 'cash_appointment' ? 'cash' : 'bank transfer'}</p>
      {series.next_booking && <p>Next booking: <button className="admin-link-button" onClick={() => openBooking(series.next_booking.id)}>{day(series.next_booking.date)} · {label(series.next_booking.booking_status)}</button></p>}
      {!series.next_booking && series.next_held_date && <p>Next session: {day(series.next_held_date)} (booked closer to the day, when payment is asked for)</p>}
      {series.skipped.length > 0 && <ul className="admin-special-list" aria-label="Dates not booked">{series.skipped.map(item => <li key={item.date}>
        <div><strong>{day(item.date)}</strong><span>{SKIP_LABELS[item.reason]}</span></div>
        {canPutBack(item.reason) && series.status === 'active' && <div className="admin-payment-buttons"><button disabled={busy} onClick={() => act(() => api.unskip(series.id, item.date))}>Put back</button></div>}
      </li>)}</ul>}
      {series.status !== 'ended' && <>
        <form className="admin-repeat-skip" onSubmit={event => { event.preventDefault(); if (skipDate[series.id]) act(() => api.skip(series.id, skipDate[series.id]).then(() => setSkipDate({ ...skipDate, [series.id]: '' }))) }}>
          <label className="admin-field">Skip a date<input type="date" min={today()} value={skipDate[series.id] || ''} disabled={busy} onChange={event => setSkipDate({ ...skipDate, [series.id]: event.target.value })} /></label>
          <button type="submit" disabled={busy || !skipDate[series.id]}>Skip this date</button>
        </form>
        {stopping === series.id
          ? <div role="alert" className="admin-conflicts"><p>Stop this repeat? The weekly slot is released. Bookings already made stay until you cancel them.</p>
              <div className="admin-payment-buttons"><button disabled={busy} onClick={() => setStopping(null)}>Keep it</button><button disabled={busy} onClick={() => act(() => api.setStatus(series.id, 'ended'))}>Yes, stop repeating</button></div></div>
          : <div className="admin-payment-buttons">
              <button disabled={busy} onClick={() => act(() => api.setStatus(series.id, series.status === 'active' ? 'paused' : 'active'))}>{series.status === 'active' ? 'Pause' : 'Resume'}</button>
              <button disabled={busy} onClick={() => setStopping(series.id)}>Stop repeating</button>
            </div>}
      </>}
    </article>)}
    <p className="admin-detail-hint">The weekly slot is kept free for this client. About a week before each session it becomes a booking and they are asked to pay for it.</p>
  </section>
}
