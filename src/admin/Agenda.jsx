import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { createCalendarApi } from './calendarApi.js'
import { bookingState, clientName, dateLabel, money, postcode, sessionSummary, shiftDate, time, today } from './calendarPresentation.js'

const api = createCalendarApi(supabase)
const CHUNK_DAYS = 31
const pending = new Map()

function loadRange(start, end) {
  const key = `${start}:${end}`
  if (!pending.has(key)) pending.set(key, api.loadAgendaRange(start, end).finally(() => pending.delete(key)))
  return pending.get(key)
}

function groupByDate(bookings) {
  const groups = []
  for (const booking of bookings) {
    const previous = groups.at(-1)
    if (previous?.date === booking.date) previous.bookings.push(booking)
    else groups.push({ date: booking.date, bookings: [booking] })
  }
  return groups
}

export default function Agenda({ openBooking, revision }) {
  const [result, setResult] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [paging, setPaging] = useState(null)
  const [pagingError, setPagingError] = useState('')
  const [now, setNow] = useState(Date.now)
  const readVersion = useRef(0)

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])

  useEffect(() => {
    let live = true
    const version = ++readVersion.current
    const start = today()
    const end = shiftDate(start, CHUNK_DAYS)
    setResult(null)
    setPagingError('')
    loadRange(start, end).then(bookings => {
      if (live && version === readVersion.current) setResult({ start, end, attempt, revision, bookings })
    }, error => {
      if (live && version === readVersion.current) setResult({ start, end, attempt, revision, error: error.message, bookings: [] })
    })
    return () => { live = false }
  }, [attempt, revision])

  const current = result?.attempt === attempt && result?.revision === revision ? result : null
  const groups = current && !current.error ? groupByDate(current.bookings) : []

  async function extend(direction) {
    if (!current || current.error || paging) return
    const version = ++readVersion.current
    const start = direction === 'older' ? shiftDate(current.start, -CHUNK_DAYS) : current.end
    const end = direction === 'older' ? current.start : shiftDate(current.end, CHUNK_DAYS)
    setPaging(direction)
    setPagingError('')
    try {
      const bookings = await loadRange(start, end)
      if (version !== readVersion.current) return
      setResult(previous => {
        if (!previous || previous.attempt !== attempt || previous.revision !== revision) return previous
        return direction === 'older'
          ? { ...previous, start, bookings: [...bookings, ...previous.bookings] }
          : { ...previous, end, bookings: [...previous.bookings, ...bookings] }
      })
    } catch (error) {
      if (version === readVersion.current) setPagingError('Could not load more appointments. Please retry.')
    } finally {
      if (version === readVersion.current) setPaging(null)
    }
  }

  return <section className="admin-agenda" aria-labelledby="agenda-title">
    <header className="admin-agenda-heading">
      <div><h1 id="agenda-title">Agenda</h1><p>Appointments in chronological order · London time</p></div>
      <button aria-label="Refresh agenda" title="Refresh agenda" onClick={() => setAttempt(value => value + 1)}>↻</button>
    </header>

    {!current && <p role="status">Loading agenda…</p>}
    {current?.error && <><p role="alert">Could not load agenda: {current.error}</p><button onClick={() => setAttempt(value => value + 1)}>Retry agenda</button></>}

    {current && !current.error && <>
      <button className="admin-agenda-load" disabled={Boolean(paging)} onClick={() => extend('older')}>{paging === 'older' ? 'Loading earlier…' : 'Load earlier appointments'}</button>
      {!current.bookings.length && <p className="admin-day-note">No appointments in the loaded date range.</p>}
      <div className="admin-agenda-days">
        {groups.map(group => <section className="admin-agenda-day" key={group.date} aria-labelledby={`agenda-${group.date}`}>
          <header className="admin-agenda-day-heading">
            <h2 id={`agenda-${group.date}`}>{dateLabel(group.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h2>
            <span>{group.bookings.length} {group.bookings.length === 1 ? 'booking' : 'bookings'}</span>
          </header>
          <ol className="admin-timeline" aria-label={`Appointments for ${dateLabel(group.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`}>
            {group.bookings.map(booking => <li key={booking.id} className="admin-timeline-row admin-timeline-booking">
              <time className="admin-time">{time(booking.start_minutes)}</time>
              <button className={`admin-card ${booking.booking_status === 'cancelled' ? 'cancelled' : ''}`} onClick={() => openBooking(booking.id)}>
                <span className="admin-card-heading"><strong>{clientName(booking)}</strong><span className="admin-card-price">{money(booking.total_gbp)}</span></span>
                <span className="admin-card-treatment">{sessionSummary(booking)}</span>
                <span className="admin-card-postcode">{postcode(booking.postcode_snapshot)}</span>
                <span className={`admin-status ${bookingState(booking, now).tone}`}>{bookingState(booking, now).text}</span>
              </button>
            </li>)}
          </ol>
        </section>)}
      </div>
      {pagingError && <p role="alert">{pagingError}</p>}
      <button className="admin-agenda-load" disabled={Boolean(paging)} onClick={() => extend('newer')}>{paging === 'newer' ? 'Loading more…' : 'Load more upcoming appointments'}</button>
      <p className="admin-agenda-range">Loaded {dateLabel(current.start, { day: 'numeric', month: 'short', year: 'numeric' })} – {dateLabel(shiftDate(current.end, -1), { day: 'numeric', month: 'short', year: 'numeric' })}</p>
    </>}
  </section>
}
