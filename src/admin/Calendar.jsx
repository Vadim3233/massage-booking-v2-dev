import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { createCalendarApi } from './calendarApi.js'
import { useQuietRetry, useReturnRefresh } from './useReturnRefresh.js'
import BookingCard from './BookingCard.jsx'
import { dateLabel, dayTimeline, shiftDate, time, today } from './calendarPresentation.js'
const BlockDialog = lazy(() => import('./BlockDialog.jsx'))
const api = createCalendarApi(supabase)
// One owner for all Calendar reads, including StrictMode's repeated mount effect. A later change or refresh is a new read.
let inFlight
function load(date, version) {
  const key = `${date}:${version}`
  if (inFlight?.key === key) return inFlight.promise
  const promise = api.loadCalendarRange(date, shiftDate(date, 1)).finally(() => { if (inFlight?.promise === promise) inFlight = null })
  inFlight = { key, promise }; return promise
}
export default function Calendar({ signOut, openBooking, openDay, revision, initialDate, onDate }) {
  const [date, setDate] = useState(() => initialDate || today())
  // The day last read stays on screen while it is read again, so a change never blanks the page or loses the place.
  const [loaded, setLoaded] = useState(null)
  const [failure, setFailure] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const shownDate = useRef(null)
  const reread = useCallback(() => setAttempt(value => value + 1), [])
  const quiet = useQuietRetry(reread)
  const [now, setNow] = useState(Date.now)
  const [headerHidden, setHeaderHidden] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [blockDialog, setBlockDialog] = useState(null)
  // The day on screen is the day a new booking starts on, so the page that owns the New booking button needs to know it.
  useEffect(() => { onDate?.(date); return () => onDate?.(undefined) }, [date, onDate])
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer) }, [])
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
    load(date, `${attempt}:${revision}`).then(data => {
      if (!live) return
      shownDate.current = date
      quiet.succeeded()
      setLoaded({ date, data })
      setFailure(null)
    }, error => {
      if (!live) return
      // A day already on screen that cannot be refreshed just now is tried once more, quietly, before anyone is told.
      if (shownDate.current === date && quiet.failed()) return
      setFailure({ date, message: error.message })
    })
    return () => { live = false }
  }, [date, attempt, revision, quiet])
  useReturnRefresh(reread)
  const data = loaded?.date === date ? loaded.data : null
  const failed = failure?.date === date
  const timeline = data && dayTimeline(data, date, now)
  function navigate(value) { if (!value) return; setDate(value); setHeaderHidden(false) }
  return <>
    <header className={`admin-header ${headerHidden && !accountOpen ? 'is-hidden' : ''}`} onFocusCapture={() => setHeaderHidden(false)}>
      <div className="admin-toolbar">
        <label className="admin-date-control"><span>{dateLabel(date)}</span><span aria-hidden="true">⌄</span>
          <input aria-label="Calendar date" type="date" value={date} onChange={event => navigate(event.target.value)} onClick={event => { try { event.currentTarget.showPicker?.() } catch { /* Native date entry remains available. */ } }} />
        </label>
        <button className="admin-today" onClick={() => navigate(today())}>Today</button>
        <button aria-label="Refresh calendar" title="Refresh calendar" onClick={() => { quiet.asked(); reread() }}>↻</button>
        <div className="admin-account" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setAccountOpen(false) }} onKeyDown={event => { if (event.key === 'Escape') { setAccountOpen(false); event.currentTarget.querySelector('button').focus() } }}>
          <button aria-label="Account menu" title="Account" aria-expanded={accountOpen} aria-controls="admin-account-actions" onClick={() => setAccountOpen(value => !value)}>⋯</button>
          {accountOpen && <div id="admin-account-actions" className="admin-account-actions"><button onClick={signOut}>Sign out</button></div>}
        </div>
      </div>
      <nav className="admin-date-strip" aria-label="Calendar navigation">
        <button aria-label="Previous day" onClick={() => navigate(shiftDate(date, -1))}>‹</button>
        {[-2, -1, 0, 1, 2].map(offset => {
          const day = shiftDate(date, offset)
          return <button key={day} className="admin-day-choice" aria-label={dateLabel(day, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} aria-current={offset === 0 ? 'date' : undefined} onClick={() => navigate(day)}><span>{dateLabel(day, { weekday: 'short' })}</span>{' '}<strong>{Number(day.slice(-2))}</strong></button>
        })}
        <button aria-label="Next day" onClick={() => navigate(shiftDate(date, 1))}>›</button>
      </nav>
    </header>
    <div className="admin-create-entry">
      {openDay && <button className="admin-secondary-entry btn--small" onClick={() => openDay(date)}>Day settings</button>}
      <button className="admin-secondary-entry btn--small" onClick={() => setBlockDialog({ date })}>Block time</button>
    </div>
    <section className="admin-day" aria-label="Day appointments">
      <h1 className="admin-sr-only">Appointments for {dateLabel(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h1>
      <p className="admin-day-caption">London time</p>
      {!data && !failed && <div className="skeleton-rows" role="status" aria-label="Loading calendar"><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>}
      {failed && <div role={data ? 'status' : 'alert'} className="error"><p>{data ? 'Could not refresh the calendar just now.' : 'Could not load calendar. Please check your connection and try again.'}</p><button className="btn--small" onClick={() => { quiet.asked(); reread() }}>{data ? 'Try again' : 'Retry calendar'}</button></div>}
      {data && <>
        <p className="admin-working-hours">{timeline.hours?.available ? `Working hours ${time(timeline.hours.start_minutes)}–${time(timeline.hours.end_minutes)}` : 'Not a working day'}</p>
        {!data.bookings.length && <p className="admin-day-note">No appointments for this day.</p>}
        <ol role="list" className="admin-timeline" aria-label="Day timeline">
          {timeline.rows.map(row => <li key={`${row.kind}-${row.id}`} className={`admin-timeline-row admin-timeline-${row.kind}`} data-start={row.start}>
            {row.kind === 'booking' ? <BookingCard booking={row.booking} open={() => openBooking(row.booking.id)} now={new Date(now)} /> : row.kind === 'block' && row.block.kind !== 'series_hold' ? <button className="admin-timeline-entry block admin-block-button" onClick={() => setBlockDialog({ date, block: row.block })}>
                <span>{row.title}</span>
                <small>{time(row.start)} – {time(row.end)} · tap to change</small>
            </button> : <div className={`admin-timeline-entry ${row.kind}`}>
                <span>{row.kind === 'free' ? 'Free' : row.kind === 'buffer' ? 'Travel / buffer' : row.kind === 'hold' ? 'Temporary hold' : row.title}</span>
                <small>{time(row.start)} – {time(row.end)}{row.kind === 'free' ? ` · ${row.end - row.start} min` : ''}</small>
            </div>}
          </li>)}
        </ol>
      </>}
    </section>
    {blockDialog && <Suspense fallback={null}><BlockDialog date={blockDialog.date} block={blockDialog.block} close={() => setBlockDialog(null)} saved={() => { setBlockDialog(null); setAttempt(value => value + 1) }} /></Suspense>}
  </>
}
