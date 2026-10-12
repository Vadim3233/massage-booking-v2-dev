import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../../../ui/icons.jsx'
import './dayTimePicker.css'
import { londonDate, timeLabel } from '../bookingDraft.js'
import { addDays, clampStrip, dayParts, STRIP_DAYS, stripFrom } from '../dateStrip.js'
import { groupSlots } from '../timeOfDay.js'

const monthWord = (date, options) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', ...options }).format(new Date(`${date}T12:00:00Z`))

// Choosing a day and a time: five days at a time with a dot where there is room, the first free day already open,
// the times of that day in short rows, and the calendar behind a field for anything further away.
// Used for a new booking and for moving one, so both feel the same.
export default function DayTimePicker({ horizonDays, dateLabel = 'Appointment date', loadDay, reloadKey = '', initialDate = '', selected, onPick, emptyMessage, renderEmpty }) {
  const today = londonDate()
  const last = londonDate(horizonDays)
  const [viewDate, setViewDate] = useState(initialDate)
  const [stripStart, setStripStart] = useState(() => clampStrip(initialDate || today, today, last))
  const [days, setDays] = useState({})
  const latest = useRef({})
  const asked = useRef(new Set())
  const lastReload = useRef(reloadKey)
  const alive = useRef(true)
  const loadDayRef = useRef(loadDay)
  useEffect(() => { loadDayRef.current = loadDay })
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  // Asks for one day's times. A slower answer to an older question never replaces a newer one.
  const load = useCallback((date) => {
    asked.current.add(date)
    const ticket = (latest.current[date] || 0) + 1
    latest.current[date] = ticket
    return loadDayRef.current(date).then(
      (slots) => { if (alive.current && latest.current[date] === ticket) setDays((known) => ({ ...known, [date]: { slots } })) },
      (error) => { if (alive.current && latest.current[date] === ticket) setDays((known) => ({ ...known, [date]: { slots: [], error: error.message } })) },
    )
  }, [])

  // With no day chosen yet, look ahead for the first one that has a free time, five days at a time.
  useEffect(() => {
    if (viewDate) return undefined
    let live = true
    ;(async () => {
      for (let offset = 0; offset <= horizonDays; offset += STRIP_DAYS) {
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

  // The five days on show; then the chosen day again whenever the time held for this visitor changes.
  useEffect(() => { for (const date of stripFrom(stripStart).filter((day) => day <= last)) if (!asked.current.has(date)) load(date) }, [stripStart, last, load])
  useEffect(() => {
    if (!viewDate) return
    const changed = lastReload.current !== reloadKey
    lastReload.current = reloadKey
    if (changed || !asked.current.has(viewDate)) load(viewDate)
  }, [viewDate, reloadKey, load])

  const view = viewDate ? days[viewDate] : null
  const groups = groupSlots(view?.slots || [])
  const dates = stripFrom(stripStart).filter((date) => date <= last)
  const nextFree = view && !view.slots.length ? Object.keys(days).sort().find((date) => date > viewDate && days[date].slots?.length) : null
  const months = [...new Set(dates.map((date) => monthWord(date, { month: 'long', year: 'numeric' })))].join(' – ')
  function pick(date) { if (date) { setViewDate(date); setStripStart(clampStrip(date, today, last)) } }

  return <div className="dtp">
    <div className="daystrip" role="group" aria-label="Choose a day">
      <button type="button" className="daystrip-arrow" aria-label="Earlier days" disabled={stripStart <= today} onClick={() => setStripStart(clampStrip(addDays(stripStart, -STRIP_DAYS), today, last))}><Icon name="left" size={22} /></button>
      {dates.map((date) => {
        const parts = dayParts(date)
        const known = days[date]
        const free = known?.slots?.length || 0
        return <button type="button" className="daychip" key={date} aria-pressed={date === viewDate} data-free={known ? (free ? 'yes' : 'no') : 'unknown'}
          aria-label={`${parts.long}, ${known ? (free ? `${free} ${free === 1 ? 'time' : 'times'} free` : 'no times free') : 'checking'}`} onClick={() => pick(date)}>
          <span className="daychip-dow">{parts.weekday}</span><span className="figure daychip-day">{parts.day}</span><span className="daychip-dot" aria-hidden="true" />
        </button>
      })}
      <button type="button" className="daystrip-arrow" aria-label="Later days" disabled={addDays(stripStart, STRIP_DAYS - 1) >= last} onClick={() => setStripStart(clampStrip(addDays(stripStart, STRIP_DAYS), today, last))}><Icon name="right" size={22} /></button>
    </div>
    <p className="strip-month">{months}</p>
    <label className="date-field">{dateLabel}<input type="date" value={viewDate} min={today} max={last} onClick={(event) => {
      try {
        event.currentTarget.showPicker?.()
      } catch {
        // Keep native date entry available when the browser restricts showPicker.
      }
    }} onChange={(event) => pick(event.target.value)} /></label>
    {!viewDate && <div className="skeleton-rows" role="status"><span className="sr-only">Finding the first free time…</span><span className="skeleton" /><span className="skeleton" /></div>}
    {viewDate && !view && <div className="skeleton-rows" role="status"><span className="sr-only">Loading available times…</span><span className="skeleton" /><span className="skeleton" /></div>}
    {view?.error && <p className="error" role="alert">{view.error}</p>}
    {groups.length > 0 && <div role="group" aria-label="Available times">
      <p className="day-name">{dayParts(viewDate).long}</p>
      {groups.map((group) => <div key={group.key}>
        {groups.length > 1 && <h2 className="slot-group">{group.label}</h2>}
        <div className="slots">{group.slots.map((start) => <button type="button" key={start} aria-pressed={selected?.date === viewDate && selected?.start === start} onClick={() => onPick(viewDate, start)}>{timeLabel(start)}</button>)}</div>
      </div>)}
    </div>}
    {view && !view.error && !view.slots.length && <>
      <p className="empty-day">{emptyMessage}</p>
      {nextFree && <button type="button" className="btn--tonal btn--block" onClick={() => pick(nextFree)}>Next free day: {dayParts(nextFree).long}</button>}
      {renderEmpty?.(viewDate)}
    </>}
  </div>
}
