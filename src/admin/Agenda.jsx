import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { createCalendarApi } from './calendarApi.js'
import PaymentActions from './PaymentActions.jsx'
import Icon from '../ui/icons.jsx'
import { reanchored } from './agendaRange.js'
import { useQuietRetry, useReturnRefresh } from './useReturnRefresh.js'
import { bookingState, clientName, dateLabel, dayHeading, daySummary, money, nextUp, postcode, sessionSummary, shiftDate, time, today } from './calendarPresentation.js'

const api = createCalendarApi(supabase)
const CHUNK_DAYS = 31
const AUTO_LOAD_UNTIL_DAYS = 186
const pending = new Map()
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000)

// Identical reads share one answer (a repeated effect, or two things asking at once), but a read asked for after something changed is a new read.
function loadRange(start, end, version) {
  const key = `${start}:${end}:${version}`
  if (!pending.has(key)) pending.set(key, api.loadAgendaRange(start, end).finally(() => pending.delete(key)))
  return pending.get(key)
}

// A read is limited to 31 days, so whatever is on show is read again a month at a time.
function loadSpan(start, end, version) {
  const parts = []
  for (let from = start; from < end; from = shiftDate(from, CHUNK_DAYS)) {
    const to = shiftDate(from, CHUNK_DAYS)
    parts.push(loadRange(from, to < end ? to : end, version))
  }
  return Promise.all(parts).then(lists => lists.flat())
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
    <div className="admin-tocheck-head">
      <p className="eyebrow">Needs you</p>
      {count > shown.length && <button className="btn--quiet admin-link-button more" onClick={seeAll}>See all {count}</button>}
    </div>
    <h2 id="tocheck-title">{count} {count === 1 ? 'payment' : 'payments'} to check · {money(toCheck.total)}</h2>
    <ul role="list">{shown.map(booking => <li key={booking.id}>
      <strong>{clientName(booking)}</strong>
      <span className="when">{dateLabel(booking.date)} · {time(booking.start_minutes)} · {booking.booking_payments.method === 'cash' ? 'Cash request' : 'Bank transfer'} · {money(booking.total_gbp)}</span>
      <PaymentActions booking={booking} refresh={checked} only={['verify', 'approve']} compact />
    </li>)}</ul>
  </section>
}

export default function Agenda({ openBooking, revision, toCheck, checked, seeAll }) {
  // What is on screen stays on screen while it is read again, so nothing flashes and the scroll position holds.
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [paging, setPaging] = useState(null)
  const [pagingError, setPagingError] = useState('')
  const [lastChunk, setLastChunk] = useState(1)
  const [now, setNow] = useState(Date.now)
  const shown = useRef(null)
  const anchor = useRef(null)
  const sentinel = useRef(null)
  const reread = useCallback(() => setAttempt(value => value + 1), [])
  const quiet = useQuietRetry(reread)
  useEffect(() => { shown.current = data ? { start: data.start, end: data.end } : null }, [data])
  // The Now and Next tags follow the clock.
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer) }, [])

  useEffect(() => {
    let live = true
    // Read again whatever range is on show (it may have been scrolled further than the first month).
    const base = shown.current
    const first = !base
    const day = today()
    // Left open past midnight and never scrolled back, the list starts again from today.
    const { start, end } = reanchored(base, anchor.current, day) ?? { start: day, end: shiftDate(day, CHUNK_DAYS) }
    loadSpan(start, end, `${attempt}:${revision}`).then(bookings => {
      if (!live) return
      // More was scrolled into view while this was being read: the range on show has moved, so read it again.
      const current = shown.current
      if (base && current && (current.start !== base.start || current.end !== base.end)) { reread(); return }
      anchor.current = day
      quiet.succeeded()
      setData({ start, end, bookings })
      if (first) setLastChunk(bookings.length || 1)
      setError('')
      setRefreshing(false)
    }, failure => {
      if (!live) return
      setRefreshing(false)
      // Just after a phone wakes, the first read often fails: it is tried once more, quietly, before anyone is told.
      if (!first && quiet.failed()) return
      setError(failure.message)
    })
    return () => { live = false }
  }, [attempt, revision, reread, quiet])
  useReturnRefresh(reread)

  const groups = data ? withToday(groupByDate(data.bookings), data.start) : []
  const upNext = data ? nextUp(data.bookings, new Date(now)) : null

  async function extend(direction) {
    if (!data || paging) return
    const start = direction === 'older' ? shiftDate(data.start, -CHUNK_DAYS) : data.end
    const end = direction === 'older' ? data.start : shiftDate(data.end, CHUNK_DAYS)
    setPaging(direction)
    setPagingError('')
    try {
      const bookings = await loadRange(start, end, `${attempt}:${revision}`)
      if (direction === 'newer') setLastChunk(bookings.length)
      setData(previous => {
        if (!previous) return previous
        return direction === 'older'
          ? { ...previous, start, bookings: [...bookings, ...previous.bookings] }
          : { ...previous, end, bookings: [...previous.bookings, ...bookings] }
      })
    } catch {
      setPagingError('Could not load more appointments. Please retry.')
    } finally {
      setPaging(null)
    }
  }

  // Keep scrolling: the next month loads as the end of the list comes into view, for as long as it is likely to hold something.
  const horizonDays = data ? daysBetween(today(), data.end) : 0
  const canAutoLoad = Boolean(data) && !paging && !pagingError && horizonDays < AUTO_LOAD_UNTIL_DAYS && (lastChunk > 0 || horizonDays < 62)
  useEffect(() => {
    const node = sentinel.current
    if (!node || !canAutoLoad || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) extend('newer') }, { rootMargin: '400px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
    // extend closes over the current range and is recreated with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAutoLoad, data?.end, paging])

  return <section className="admin-agenda" aria-labelledby="agenda-title">
    <h1 id="agenda-title" className="sr-only">Agenda</h1>

    {!data && !error && <div className="skeleton-rows" role="status"><span className="sr-only">Loading agenda…</span><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>}
    {error && <div role={data ? 'status' : 'alert'} className="error"><p>{data ? 'Could not refresh the agenda just now.' : 'Could not load the agenda. Please check your connection and try again.'}</p><button className="btn--small" onClick={() => { quiet.asked(); reread() }}>Try again</button></div>}

    {data && <>
      <ToCheck toCheck={toCheck} checked={checked} seeAll={seeAll} />
      <div className="admin-agenda-actions">
        <button className="btn--quiet btn--small admin-agenda-earlier" disabled={Boolean(paging)} onClick={() => extend('older')}>{paging === 'older' ? 'Loading earlier…' : 'Earlier appointments'}</button>
        <button className="btn--quiet btn--small" disabled={refreshing} onClick={() => { quiet.asked(); setRefreshing(true); reread() }}><Icon name="refresh" size={18} />{refreshing ? ' Refreshing…' : ' Refresh'}</button>
      </div>
      <div className="admin-agenda-days">
        {groups.map(group => {
          const heading = dayHeading(group.date)
          const full = dateLabel(group.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
          return <section className={`admin-agenda-day ${group.date === today() ? 'is-today' : ''}`} key={group.date} aria-labelledby={`agenda-${group.date}`}>
            <header className="admin-agenda-day-heading">
              <h2 id={`agenda-${group.date}`}><span className="day-name">{heading.name}</span>{heading.rest ? ` · ${heading.rest}` : ''}</h2>
              <span>{daySummary(group.bookings)}</span>
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
      {pagingError && <p role="alert" className="error">{pagingError}</p>}
      <div ref={sentinel} className="admin-agenda-sentinel" aria-hidden="true" />
      <button className="admin-agenda-load btn--quiet" disabled={Boolean(paging)} onClick={() => extend('newer')}>{paging === 'newer' ? 'Loading more…' : 'Load more upcoming appointments'}</button>
      <p className="admin-agenda-range">Showing {dateLabel(data.start, { day: 'numeric', month: 'short', year: 'numeric' })} to {dateLabel(shiftDate(data.end, -1), { day: 'numeric', month: 'short', year: 'numeric' })}</p>
    </>}
  </section>
}
