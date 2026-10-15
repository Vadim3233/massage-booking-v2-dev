import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { createCalendarApi } from './calendarApi.js'
import PaymentActions from './PaymentActions.jsx'
import Icon from '../ui/icons.jsx'
import { reanchored } from './agendaRange.js'
import { agendaDays, mergeExtras } from './agendaDays.js'
import { AwayBanner, DayNotes, QuietDays, TimedBlock } from './AgendaParts.jsx'
import { useQuietRetry, useReturnRefresh } from './useReturnRefresh.js'
import BookingCard from './BookingCard.jsx'
import { clientName, dateLabel, dayHeading, daySummary, money, nextUp, shiftDate, time, today } from './calendarPresentation.js'

const BlockDialog = lazy(() => import('./BlockDialog.jsx'))
const api = createCalendarApi(supabase)
const SHOW_EVERY_KEY = 'vad-admin-agenda-show-every'
const CHUNK_DAYS = 31
const AUTO_LOAD_UNTIL_DAYS = 186
// The list reads on by itself this far ahead however little is there, so time away and special days a few months off are seen without pressing
// anything. After that it goes on only while each month it reads has something in it.
const MIN_HORIZON_DAYS = 93
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

// Blocked time and special days are read the same way, a month at a time, and the usual week once, so the Agenda can say what changes the diary.
function loadExtrasRange(start, end, version) {
  const key = `extras:${start}:${end}:${version}`
  if (!pending.has(key)) pending.set(key, api.loadAgendaExtras(start, end).finally(() => pending.delete(key)))
  return pending.get(key)
}
function loadExtrasSpan(start, end, version) {
  const parts = []
  for (let from = start; from < end; from = shiftDate(from, CHUNK_DAYS)) {
    const to = shiftDate(from, CHUNK_DAYS)
    parts.push(loadExtrasRange(from, to < end ? to : end, version))
  }
  return Promise.all(parts).then(mergeExtras)
}
function loadWeekly(version) {
  const key = `weekly:${version}`
  if (!pending.has(key)) pending.set(key, api.loadWeeklyHours().finally(() => pending.delete(key)))
  return pending.get(key)
}
// Whether "Show every day" was left on, on this device. Unreadable storage just means off.
function readShowEvery() {
  try { return localStorage.getItem(SHOW_EVERY_KEY) === '1' } catch { return false }
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

export default function Agenda({ openBooking, openDay, revision, toCheck, checked, seeAll }) {
  // What is on screen stays on screen while it is read again, so nothing flashes and the scroll position holds.
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [paging, setPaging] = useState(null)
  const [pagingError, setPagingError] = useState('')
  const [lastChunk, setLastChunk] = useState(1)
  const [now, setNow] = useState(Date.now)
  const [showEvery, setShowEvery] = useState(readShowEvery)
  const [blockDialog, setBlockDialog] = useState(null)
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
    const version = `${attempt}:${revision}`
    Promise.all([loadSpan(start, end, version), loadExtrasSpan(start, end, version), loadWeekly(version)]).then(([bookings, extras, weekly]) => {
      if (!live) return
      // More was scrolled into view while this was being read: the range on show has moved, so read it again.
      const current = shown.current
      if (base && current && (current.start !== base.start || current.end !== base.end)) { reread(); return }
      anchor.current = day
      quiet.succeeded()
      setData({ start, end, bookings, ...extras, weekly })
      if (first) setLastChunk(bookings.length + extras.blocks.length + extras.overrides.length || 1)
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

  const entries = data ? agendaDays({ bookings: data.bookings, blocks: data.blocks, overrides: data.overrides, weekly: data.weekly, start: data.start, end: data.end, day: today(), showEvery }) : []
  const upNext = data ? nextUp(data.bookings, new Date(now)) : null

  async function extend(direction) {
    if (!data || paging) return
    const start = direction === 'older' ? shiftDate(data.start, -CHUNK_DAYS) : data.end
    const end = direction === 'older' ? data.start : shiftDate(data.end, CHUNK_DAYS)
    setPaging(direction)
    setPagingError('')
    try {
      const version = `${attempt}:${revision}`
      const [bookings, extras] = await Promise.all([loadRange(start, end, version), loadExtrasRange(start, end, version)])
      if (direction === 'newer') setLastChunk(bookings.length + extras.blocks.length + extras.overrides.length)
      setData(previous => {
        if (!previous) return previous
        const more = mergeExtras([previous, extras])
        return direction === 'older'
          ? { ...previous, ...more, start, bookings: [...bookings, ...previous.bookings] }
          : { ...previous, ...more, end, bookings: [...previous.bookings, ...bookings] }
      })
    } catch {
      setPagingError('Could not load more appointments. Please retry.')
    } finally {
      setPaging(null)
    }
  }

  // Keep scrolling: the next month loads as the end of the list comes into view, for as long as it is likely to hold something.
  const horizonDays = data ? daysBetween(today(), data.end) : 0
  const canAutoLoad = Boolean(data) && !paging && !pagingError && horizonDays < AUTO_LOAD_UNTIL_DAYS && (lastChunk > 0 || horizonDays < MIN_HORIZON_DAYS)
  useEffect(() => {
    const node = sentinel.current
    if (!node || !canAutoLoad || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) extend('newer') }, { rootMargin: '400px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
    // extend closes over the current range and is recreated with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAutoLoad, data?.end, paging])

  function toggleShowEvery(event) {
    const on = event.target.checked
    setShowEvery(on)
    try { localStorage.setItem(SHOW_EVERY_KEY, on ? '1' : '0') } catch { /* A convenience only: a phone that will not keep it is not told. */ }
  }
  // A block, wherever it is shown, opens as in the Day view; what is changed or removed there is read again.
  const openBlock = row => setBlockDialog({ date: row.date, block: row })

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
      <div className="admin-agenda-options">
        {openDay && <label className="admin-agenda-pick"><Icon name="calendar" size={18} /><span>Day settings for a date</span>
          <input type="date" value="" onChange={event => { if (event.target.value) openDay(event.target.value) }} onClick={event => { try { event.currentTarget.showPicker?.() } catch { /* Native date entry remains available. */ } }} />
        </label>}
        <label className="admin-agenda-switch"><input type="checkbox" role="switch" checked={showEvery} onChange={toggleShowEvery} />Show every day</label>
      </div>
      <div className="admin-agenda-days">
        {entries.map(entry => {
          if (entry.type === 'away') return <AwayBanner key={`away-${entry.group.key}`} group={entry.group} open={openBlock} />
          if (entry.type === 'quiet') return <QuietDays key={entry.key} items={entry.items} open={openBlock} openDay={openDay} />
          const group = entry
          const heading = dayHeading(group.date)
          const full = dateLabel(group.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
          return <section className={`admin-agenda-day ${group.date === today() ? 'is-today' : ''}`} key={group.date} aria-labelledby={`agenda-${group.date}`}>
            <header className="admin-agenda-day-heading">
              <h2 id={`agenda-${group.date}`}><span className="day-name">{heading.name}</span>{heading.rest ? ` · ${heading.rest}` : ''}</h2>
              <span>{daySummary(group.bookings)}</span>
              {openDay && <button type="button" className="btn--quiet btn--small admin-day-settings-button" aria-label={`Day settings for ${full}`} onClick={() => openDay(group.date)}><Icon name="clock" size={16} /> Day settings</button>}
            </header>
            <DayNotes special={group.special} away={group.away} />
            {!group.bookings.length && <p className="admin-agenda-empty"><strong>{group.special?.available === false || group.away ? 'A day off.' : 'A free day.'}</strong>Nothing is booked.</p>}
            {group.rows.length > 0 && <ol role="list" className="admin-timeline" aria-label={`Appointments${group.rows.some(row => row.kind === 'block') ? ' and blocked time' : ''} for ${full}`}>
              {group.rows.map(({ kind, booking, row: blocked }) => kind === 'block' ? <TimedBlock key={`block-${blocked.id}`} row={blocked} open={openBlock} /> : <li key={booking.id} className="admin-timeline-row admin-timeline-booking">
                <time className="admin-time"><span className="figure">{time(booking.start_minutes)}</span><small>{booking.treatment_duration_minutes} min</small>{upNext?.id === booking.id && <em className="admin-next-tag">{upNext.now ? 'Now' : 'Next'}</em>}</time>
                <BookingCard booking={booking} open={() => openBooking(booking.id)} now={new Date(now)} />
              </li>)}
            </ol>}
          </section>
        })}
      </div>
      {pagingError && <p role="alert" className="error">{pagingError}</p>}
      <div ref={sentinel} className="admin-agenda-sentinel" aria-hidden="true" />
      <button className="admin-agenda-load btn--quiet" disabled={Boolean(paging)} onClick={() => extend('newer')}>{paging === 'newer' ? 'Loading more…' : 'Load more upcoming appointments'}</button>
      <p className="admin-agenda-range">Showing {dateLabel(data.start, { day: 'numeric', month: 'short', year: 'numeric' })} to {dateLabel(shiftDate(data.end, -1), { day: 'numeric', month: 'short', year: 'numeric' })}</p>
    </>}
    {blockDialog && <Suspense fallback={null}><BlockDialog date={blockDialog.date} block={blockDialog.block} close={() => setBlockDialog(null)} saved={() => { setBlockDialog(null); reread() }} /></Suspense>}
  </section>
}
