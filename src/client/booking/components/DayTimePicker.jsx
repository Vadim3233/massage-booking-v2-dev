import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../../../ui/icons.jsx'
import './dayTimePicker.css'
import { londonDate, timeLabel } from '../bookingDraft.js'
import { addDays, clampStrip, dayParts, STRIP_DAYS, stripFrom } from '../dateStrip.js'
import { friendlyError } from '../friendlyError.js'
import { groupSlots } from '../timeOfDay.js'

// Looking ahead for the first free day stops here; a client who wants a day further off picks it from the calendar.
const LOOK_AHEAD_DAYS = 60
const COULD_NOT_LOAD = "I couldn't load the times just now. Please try again in a moment."
const monthWord = (date, options) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', ...options }).format(new Date(`${date}T12:00:00Z`))

// Choosing a day and a time: five days at a time with a dot where there is room, the first free day already open,
// the times of that day in short rows, and the calendar behind a field for anything further away.
// Used for a new booking and for moving one, so both feel the same.
export default function DayTimePicker({ horizonDays, dateLabel = 'Appointment date', loadDay, reloadKey = '', initialDate = '', selected, onPick, emptyMessage, renderEmpty }) {
  const today = londonDate()
  const last = londonDate(horizonDays)
  const usable = (date) => Boolean(date) && date >= today && date <= last
  // A day that has gone by (a draft kept from yesterday) or is past the booking limit is not a starting point.
  const [viewDate, setViewDate] = useState(usable(initialDate) ? initialDate : '')
  const [stripStart, setStripStart] = useState(() => clampStrip(usable(initialDate) ? initialDate : today, today, last))
  const [days, setDays] = useState({})
  const root = useRef(null)
  const latest = useRef({})
  const asked = useRef(new Set())
  const lastReload = useRef(reloadKey)
  const alive = useRef(true)
  const loadDayRef = useRef(loadDay)
  useEffect(() => { loadDayRef.current = loadDay })
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  // Asks for one day's times. A slower answer to an older question never replaces a newer one, and a failed
  // answer is forgotten so that looking at the day again asks again.
  const load = useCallback((date) => {
    asked.current.add(date)
    const ticket = (latest.current[date] || 0) + 1
    latest.current[date] = ticket
    return loadDayRef.current(date).then(
      (slots) => { if (alive.current && latest.current[date] === ticket) setDays((known) => ({ ...known, [date]: { slots } })) },
      (error) => {
        if (!alive.current || latest.current[date] !== ticket) return
        asked.current.delete(date)
        setDays((known) => ({ ...known, [date]: { slots: [], error: friendlyError(error, COULD_NOT_LOAD) } }))
      },
    )
  }, [])

  // With no day chosen yet, look ahead for the first one that has a free time, five days at a time.
  useEffect(() => {
    if (viewDate) return undefined
    let live = true
    ;(async () => {
      for (let offset = 0; offset <= Math.min(horizonDays, LOOK_AHEAD_DAYS); offset += STRIP_DAYS) {
        const dates = stripFrom(londonDate(offset)).filter((date) => date <= last)
        const found = await Promise.all(dates.map((date) => loadDayRef.current(date).then((slots) => [date, slots], () => [date, null])))
        if (!live) return
        for (const [date, slots] of found) if (slots) asked.current.add(date)
        setDays((known) => ({ ...known, ...Object.fromEntries(found.filter(([, slots]) => slots).map(([date, slots]) => [date, { slots }])) }))
        const first = found.find(([, slots]) => slots?.length)
        // Start the row at today when the first free day is close, so the full days before it are in sight.
        if (first) { setViewDate(first[0]); setStripStart(clampStrip(first[0] <= addDays(today, STRIP_DAYS - 1) ? today : first[0], today, last)); return }
      }
      setViewDate(today)
    })()
    return () => { live = false }
  }, [viewDate, horizonDays, last, today])

  // The five days on show (the search above covers the first ones); then the chosen day again whenever the held time changes.
  useEffect(() => {
    if (!viewDate) return
    for (const date of stripFrom(stripStart).filter((day) => day <= last)) if (!asked.current.has(date)) load(date)
  }, [stripStart, last, load, viewDate])
  useEffect(() => {
    if (!viewDate) return
    const changed = lastReload.current !== reloadKey
    lastReload.current = reloadKey
    if (changed || !asked.current.has(viewDate)) load(viewDate)
  }, [viewDate, reloadKey, load])

  const view = viewDate ? days[viewDate] : null
  const groups = groupSlots(view?.slots || [])
  const dates = stripFrom(stripStart).filter((date) => date <= last)
  const nextFree = view && !view.error && !view.slots.length ? Object.keys(days).sort().find((date) => date > viewDate && days[date].slots?.length) : null
  const months = [...new Set(dates.map((date) => monthWord(date, { month: 'long', year: 'numeric' })))].join(' – ')
  const atStart = stripStart <= today
  const atEnd = addDays(stripStart, STRIP_DAYS - 1) >= last
  const freeText = (known) => (!known ? 'checking' : known.error ? 'could not load' : known.slots.length ? `${known.slots.length} ${known.slots.length === 1 ? 'time' : 'times'} free` : 'no times free')

  // Tapping a day that is already on show leaves the row where it is, so the days do not move under a finger.
  function pick(date) {
    if (!usable(date)) return
    setViewDate(date)
    if (!dates.includes(date)) setStripStart(clampStrip(date, today, last))
    // A day looked at again is asked about again, so its list is never older than the last look.
    load(date)
  }
  function choose(start) {
    const result = onPick(viewDate, start)
    // A time that could not be held (someone else just took it) is gone from the list on the next look.
    if (result && typeof result.then === 'function') result.then((ok) => { if (!ok) load(viewDate) })
  }
  function goToNextFree() {
    pick(nextFree)
    requestAnimationFrame(() => root.current?.querySelector('.daychip[aria-pressed=true]')?.focus())
  }

  return <div className="dtp" ref={root}>
    <div className="daystrip" role="group" aria-label="Choose a day">
      <button type="button" className="daystrip-arrow" aria-label="Earlier days" aria-disabled={atStart} onClick={() => { if (!atStart) setStripStart(clampStrip(addDays(stripStart, -STRIP_DAYS), today, last)) }}><Icon name="left" size={22} /></button>
      {dates.map((date) => {
        const parts = dayParts(date)
        const known = days[date]
        return <button type="button" className="daychip" key={date} aria-pressed={date === viewDate} data-free={known ? (known.error ? 'unknown' : known.slots.length ? 'yes' : 'no') : 'unknown'}
          aria-label={`${parts.weekday} ${parts.day} ${parts.month}, ${freeText(known)}`} onClick={() => pick(date)}>
          <span className="daychip-dow">{parts.weekday}</span><span className="figure daychip-day">{parts.day}</span><span className="daychip-dot" aria-hidden="true" />
        </button>
      })}
      <button type="button" className="daystrip-arrow" aria-label="Later days" aria-disabled={atEnd} onClick={() => { if (!atEnd) setStripStart(clampStrip(addDays(stripStart, STRIP_DAYS), today, last)) }}><Icon name="right" size={22} /></button>
    </div>
    <p className="strip-month">{months}</p>
    <label className="date-field">{dateLabel}<input type="date" value={viewDate} min={today} max={last} onClick={(event) => {
      try {
        event.currentTarget.showPicker?.()
      } catch {
        // Keep native date entry available when the browser restricts showPicker.
      }
    }} onChange={(event) => pick(event.target.value)} /></label>
    <p className="sr-only" role="status">{viewDate && view && !view.error ? `${dayParts(viewDate).long}: ${freeText(view)}` : ''}</p>
    {!viewDate && <div className="skeleton-rows" role="status"><span className="sr-only">Finding the first free time…</span><span className="skeleton" /><span className="skeleton" /></div>}
    {viewDate && !view && <div className="skeleton-rows" role="status"><span className="sr-only">Loading available times…</span><span className="skeleton" /><span className="skeleton" /></div>}
    {view?.error && <div className="error" role="alert"><p>{view.error}</p><button type="button" className="btn--small" onClick={() => load(viewDate)}>Try again</button></div>}
    {groups.length > 0 && <div role="group" aria-label="Available times">
      <p className="day-name">{dayParts(viewDate).long}</p>
      {groups.map((group) => <div key={group.key}>
        {groups.length > 1 && <h2 className="slot-group">{group.label}</h2>}
        <div className="slots">{group.slots.map((start) => <button type="button" key={start} aria-pressed={selected?.date === viewDate && selected?.start === start} onClick={() => choose(start)}>{timeLabel(start)}</button>)}</div>
      </div>)}
    </div>}
    {view && !view.error && !view.slots.length && <>
      <p className="empty-day">{emptyMessage}</p>
      {nextFree && <button type="button" className="btn--tonal btn--block" onClick={goToNextFree}>Next free day: {dayParts(nextFree).long}</button>}
      {renderEmpty?.(viewDate)}
    </>}
  </div>
}
