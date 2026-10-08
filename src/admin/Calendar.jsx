import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { createCalendarApi } from './calendarApi.js'
import { bookingState, clientName, dateLabel, dayTimeline, money, postcode, sessionSummary, shiftDate, time, today } from './calendarPresentation.js'
const api = createCalendarApi(supabase)
// One owner for all Calendar reads, including StrictMode's repeated mount effect.
let inFlight
function load(date) {
  if (inFlight?.date === date) return inFlight.promise
  const promise = api.loadCalendarRange(date, shiftDate(date, 1)).finally(() => { if (inFlight?.promise === promise) inFlight = null })
  inFlight = { date, promise }; return promise
}
export default function Calendar({ signOut, openBooking, revision, newBooking, initialDate }) {
  const [date, setDate] = useState(() => initialDate || today())
  const [result, setResult] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [now, setNow] = useState(Date.now)
  const [headerHidden, setHeaderHidden] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    let previous = window.scrollY, distance = 0
    function scroll() {
      const position = Math.max(0, window.scrollY)
      const delta = position - previous
      distance = Math.sign(delta) === Math.sign(distance) ? distance + delta : delta
      if (position < 80 || distance < -6) setHeaderHidden(false)
      else if (distance > 32) setHeaderHidden(true)
      previous = position
    }
    window.addEventListener('scroll', scroll, { passive: true })
    return () => window.removeEventListener('scroll', scroll)
  }, [])
  useEffect(() => {
    let live = true
    load(date).then(data => { if (live) setResult({ date, attempt, revision, data }) }, error => { if (live) setResult({ date, attempt, revision, error: error.message }) })
    return () => { live = false }
  }, [date, attempt, revision])
  const current = result?.date === date && result?.attempt === attempt && result?.revision === revision ? result : null
  const data = current?.data
  const timeline = data && dayTimeline(data, date, now)
  function navigate(value) { if (!value) return; setDate(value); setHeaderHidden(false) }
  return <>
    <header className={`admin-header ${headerHidden && !accountOpen ? 'is-hidden' : ''}`} onFocusCapture={() => setHeaderHidden(false)}>
      <div className="admin-toolbar">
        <label className="admin-date-control"><span>{dateLabel(date)}</span><span aria-hidden="true">⌄</span>
          <input aria-label="Calendar date" type="date" value={date} onChange={event => navigate(event.target.value)} onClick={event => { try { event.currentTarget.showPicker?.() } catch { /* Native date entry remains available. */ } }} />
        </label>
        <button className="admin-today" onClick={() => navigate(today())}>Today</button>
        <button aria-label="Refresh calendar" title="Refresh calendar" onClick={() => setAttempt(value => value + 1)}>↻</button>
        <div className="admin-account" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setAccountOpen(false) }} onKeyDown={event => { if (event.key === 'Escape') { setAccountOpen(false); event.currentTarget.querySelector('button').focus() } }}>
          <button aria-label="Account menu" title="Account" aria-expanded={accountOpen} aria-controls="admin-account-actions" onClick={() => setAccountOpen(value => !value)}>⋯</button>
          {accountOpen && <div id="admin-account-actions" className="admin-account-actions"><button onClick={signOut}>Sign out</button></div>}
        </div>
      </div>
      <nav className="admin-date-strip" aria-label="Calendar navigation">
        <button aria-label="Previous day" onClick={() => navigate(shiftDate(date, -1))}>‹</button>
        {[-2, -1, 0, 1, 2].map(offset => {
          const day = shiftDate(date, offset)
          return <button key={day} className="admin-day-choice" aria-label={dateLabel(day, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} aria-current={offset === 0 ? 'date' : undefined} onClick={() => navigate(day)}><span>{dateLabel(day, { weekday: 'short' })}</span><strong>{Number(day.slice(-2))}</strong></button>
        })}
        <button aria-label="Next day" onClick={() => navigate(shiftDate(date, 1))}>›</button>
      </nav>
      <div className="admin-create-entry"><button onClick={() => newBooking(date)}>+ New booking</button></div>
    </header>
    <section className="admin-day" aria-label="Day appointments">
      <h1 className="admin-sr-only">Appointments for {dateLabel(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h1>
      <p className="admin-day-caption">London time</p>
      {!current && <p role="status">Loading calendar…</p>}
      {current?.error && <><p role="alert">Could not load calendar: {current.error}</p><button onClick={() => setAttempt(value => value + 1)}>Retry calendar</button></>}
      {data && <>
        <p className="admin-working-hours">{timeline.hours?.available ? `Working hours ${time(timeline.hours.start_minutes)}–${time(timeline.hours.end_minutes)}` : 'Not a working day'}</p>
        {!data.bookings.length && <p className="admin-day-note">No appointments for this day.</p>}
        <ol className="admin-timeline" aria-label="Day timeline">
          {timeline.rows.map(row => <li key={`${row.kind}-${row.id}`} className={`admin-timeline-row admin-timeline-${row.kind}`} data-start={row.start}>
            <time className="admin-time">{time(row.start)}</time>
            {row.kind === 'booking' ? <button className={`admin-card ${row.booking.booking_status === 'cancelled' ? 'cancelled' : ''}`} onClick={() => openBooking(row.booking.id)}>
              <span className="admin-card-heading"><strong>{clientName(row.booking)}</strong><span className="admin-card-price">{money(row.booking.total_gbp)}</span></span>
              <span className="admin-card-treatment">{sessionSummary(row.booking)}</span>
              <span className="admin-card-postcode">{postcode(row.booking.postcode_snapshot)}</span>
              <span className={`admin-status ${bookingState(row.booking, now).tone}`}>{bookingState(row.booking, now).text}</span>
            </button> : <div className={`admin-timeline-entry ${row.kind}`}>
                <span>{row.kind === 'free' ? 'Free' : row.kind === 'buffer' ? 'Travel / buffer' : row.kind === 'hold' ? 'Temporary hold' : row.title}</span>
                <small>Until {time(row.end)}{row.kind === 'free' ? ` · ${row.end - row.start} min` : ''}</small>
            </div>}
          </li>)}
        </ol>
      </>}
    </section>
  </>
}
