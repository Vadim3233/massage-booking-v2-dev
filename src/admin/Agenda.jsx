import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { createCalendarApi } from './calendarApi.js'
import PaymentActions from './PaymentActions.jsx'
import Icon from '../ui/icons.jsx'
import { bookingState, clientName, dateLabel, dayHeading, money, nextUp, postcode, sessionSummary, shiftDate, time, today } from './calendarPresentation.js'

const api = createCalendarApi(supabase)
const CHUNK_DAYS = 31
const AUTO_LOAD_UNTIL_DAYS = 186
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

// Today is always shown, even when nothing is booked, so there is always a fixed point to scroll from.
function withToday(groups, start) {
  const day = today()
  if (day < start || groups.some(group => group.date === day)) return groups
  const index = groups.findIndex(group => group.date > day)
  const empty = { date: day, bookings: [] }
  return index === -1 ? [...groups, empty] : [...groups.slice(0, index), empty, ...groups.slice(index)]
}

// What needs the Admin, first thing: declared transfers and cash requests, each one tap and a confirmation away.
function ToCheck({ toCheck, checked, seeAll }) {
  if (!toCheck?.needs.length) return null
  const shown = toCheck.needs.slice(0, 2)
  const count = toCheck.needs.length
  return <section className="admin-tocheck" aria-labelledby="tocheck-title">
    <p className="eyebrow">Needs you</p>
    <h2 id="tocheck-title">{count} {count === 1 ? 'payment' : 'payments'} to check · {money(toCheck.total)}</h2>
    <ul role="list">{shown.map(booking => <li key={booking.id}>
      <strong>{clientName(booking)}</strong>
      <span className="when">{dateLabel(booking.date)} · {time(booking.start_minutes)} · {booking.booking_payments.method === 'cash' ? 'Cash request' : 'Bank transfer'} · {money(booking.total_gbp)}</span>
      <PaymentActions booking={booking} refresh={checked} only={['verify', 'approve']} compact />
    </li>)}</ul>
    {count > shown.length && <button className="btn--quiet admin-link-button more" onClick={seeAll}>See all {count}</button>}
  </section>
}

export default function Agenda({ openBooking, revision, toCheck, checked, seeAll }) {
  const [result, setResult] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [paging, setPaging] = useState(null)
  const [pagingError, setPagingError] = useState(null)
  const [lastChunk, setLastChunk] = useState(1)
  const readVersion = useRef(0)
  const sentinel = useRef(null)

  useEffect(() => {
    let live = true
    const version = ++readVersion.current
    const start = today()
    const end = shiftDate(start, CHUNK_DAYS)
    loadRange(start, end).then(bookings => {
      if (live && version === readVersion.current) { setResult({ start, end, attempt, revision, bookings }); setLastChunk(bookings.length || 1) }
    }, error => {
      if (live && version === readVersion.current) setResult({ start, end, attempt, revision, error: error.message, bookings: [] })
    })
    return () => { live = false }
  }, [attempt, revision])

  const current = result?.attempt === attempt && result?.revision === revision ? result : null
  const groups = current && !current.error ? withToday(groupByDate(current.bookings), current.start) : []
  const upNext = current && !current.error ? nextUp(current.bookings) : null

  async function extend(direction) {
    if (!current || current.error || paging) return
    const version = ++readVersion.current
    const start = direction === 'older' ? shiftDate(current.start, -CHUNK_DAYS) : current.end
    const end = direction === 'older' ? current.start : shiftDate(current.end, CHUNK_DAYS)
    setPaging(direction)
    setPagingError(null)
    try {
      const bookings = await loadRange(start, end)
      if (version !== readVersion.current) return
      if (direction === 'newer') setLastChunk(bookings.length)
      setResult(previous => {
        if (!previous || previous.attempt !== attempt || previous.revision !== revision) return previous
        return direction === 'older'
          ? { ...previous, start, bookings: [...bookings, ...previous.bookings] }
          : { ...previous, end, bookings: [...previous.bookings, ...bookings] }
      })
    } catch {
      if (version === readVersion.current) setPagingError({ key: `${attempt}:${revision}`, message: 'Could not load more appointments. Please retry.' })
    } finally {
      if (version === readVersion.current) setPaging(null)
    }
  }

  // Keep scrolling: the next month loads as the end of the list comes into view, for as long as it is likely to hold something.
  const horizonDays = current ? Math.round((Date.parse(current.end) - Date.parse(today())) / 86400000) : 0
  const canAutoLoad = Boolean(current) && !current.error && !paging && !pagingError && horizonDays < AUTO_LOAD_UNTIL_DAYS && (lastChunk > 0 || horizonDays < 62)
  useEffect(() => {
    const node = sentinel.current
    if (!node || !canAutoLoad || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) extend('newer') }, { rootMargin: '400px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
    // extend closes over the current range and is recreated with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAutoLoad, current?.end, paging])

  return <section className="admin-agenda" aria-labelledby="agenda-title">
    <header className="admin-agenda-heading">
      <h1 id="agenda-title" className="admin-sr-only">Agenda</h1>
      <button className="btn--quiet btn--icon" aria-label="Refresh agenda" title="Refresh agenda" onClick={() => setAttempt(value => value + 1)}><Icon name="refresh" size={22} /></button>
    </header>

    {!current && <div className="skeleton-rows" role="status"><span className="admin-sr-only">Loading agenda…</span><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>}
    {current?.error && <><p role="alert">Could not load the agenda. Please check your connection and try again.</p><button onClick={() => setAttempt(value => value + 1)}>Retry agenda</button></>}

    {current && !current.error && <>
      <ToCheck toCheck={toCheck} checked={checked} seeAll={seeAll} />
      <div className="admin-agenda-actions"><button className="btn--quiet btn--small admin-agenda-earlier" disabled={Boolean(paging)} onClick={() => extend('older')}>{paging === 'older' ? 'Loading earlier…' : 'Load earlier appointments'}</button></div>
      <div className="admin-agenda-days">
        {groups.map(group => {
          const heading = dayHeading(group.date)
          const full = dateLabel(group.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
          return <section className={`admin-agenda-day ${group.date === today() ? 'is-today' : ''}`} key={group.date} aria-labelledby={`agenda-${group.date}`}>
            <header className="admin-agenda-day-heading">
              <h2 id={`agenda-${group.date}`}><span className="day-name">{heading.name}</span>{heading.rest ? ` · ${heading.rest}` : ''}</h2>
              <span>{group.bookings.length ? `${group.bookings.length} ${group.bookings.length === 1 ? 'booking' : 'bookings'}` : 'Free'}</span>
            </header>
            {!group.bookings.length && <p className="admin-agenda-empty"><strong>A free day.</strong>Nothing is booked.</p>}
            {group.bookings.length > 0 && <ol role="list" className="admin-timeline" aria-label={`Appointments for ${full}`}>
              {group.bookings.map(booking => {
                const state = bookingState(booking)
                return <li key={booking.id} className="admin-timeline-row admin-timeline-booking">
                  <time className="admin-time"><span className="figure">{time(booking.start_minutes)}</span><small>{booking.treatment_duration_minutes} min</small>{upNext?.id === booking.id && <em className="admin-next-tag">{upNext.now ? 'Now' : 'Next'}</em>}</time>
                  <button className={`admin-card ${booking.booking_status === 'cancelled' ? 'cancelled' : ''}`} data-chip={state.chip} onClick={() => openBooking(booking.id)}>
                    <span className="admin-card-heading"><strong>{clientName(booking)}</strong><span className="admin-card-price">{money(booking.total_gbp)}</span></span>
                    <span className="admin-card-treatment">{sessionSummary(booking)}</span>
                    <span className="admin-card-postcode">{postcode(booking.postcode_snapshot)}</span>
                    <span className={`chip chip--${state.chip} admin-status ${state.tone}`}>{state.text}</span>
                  </button>
                </li>
              })}
            </ol>}
          </section>
        })}
      </div>
      {pagingError?.key === `${attempt}:${revision}` && <p role="alert">{pagingError.message}</p>}
      <div ref={sentinel} className="admin-agenda-sentinel" aria-hidden="true" />
      <button className="admin-agenda-load btn--quiet" disabled={Boolean(paging)} onClick={() => extend('newer')}>{paging === 'newer' ? 'Loading more…' : 'Load more upcoming appointments'}</button>
      <p className="admin-agenda-range">Showing {dateLabel(current.start, { day: 'numeric', month: 'short', year: 'numeric' })} to {dateLabel(shiftDate(current.end, -1), { day: 'numeric', month: 'short', year: 'numeric' })}</p>
    </>}
  </section>
}
