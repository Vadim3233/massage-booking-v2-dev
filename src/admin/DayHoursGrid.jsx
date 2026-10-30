import { useCallback, useEffect, useRef, useState } from 'react'
import { clock, scheduleApi } from './scheduleApi.js'
import { applyEdits, changeCount, closeAll, heldLine, hoursSummary, isDayOff, openMinutes, visibleRange, withLabels } from './dayGrid.js'
import { isDate } from './daySettings.js'
import { dateLabel, today } from './calendarPresentation.js'
import { toast } from '../ui/toast.js'
import './dayHoursGrid.css'

const HOLD_MS = 350

const LOCKED_WHY = {
  booking: 'This half hour has a booking. Move or cancel the booking first.',
  travel: 'This is travel time for a booking, so it stays as it is.',
  block: 'This is blocked time with its own name. Change it from the Day view.',
}

// One day as half-hour blocks (ADR-080), opened with Edit hours from the Day view. Green is working, empty is not; a tap changes one half hour and a
// slide down several changes them together. On a phone a swipe scrolls the day, so a slide starts with a short hold on the first block. Saving writes the day's hours and blocked time; the database works out both and refuses what a booking
// needs. `done` goes back to the Day view.
export default function DayHoursGrid({ date, done, changed, api = scheduleApi }) {
  const valid = isDate(date)
  const [rows, setRows] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [edits, setEdits] = useState({})
  const [range, setRange] = useState({ earlier: false, later: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [why, setWhy] = useState('')
  const [held, setHeld] = useState(null)
  const [discarding, setDiscarding] = useState(false)
  const drag = useRef(null)
  const press = useRef(null)
  const list = useRef(null)
  const heading = useRef(null)
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [])

  useEffect(() => {
    if (!valid) return undefined
    let live = true
    api.dayGrid(date).then(result => { if (live) { setRows(result); setLoadError('') } },
      () => { if (live) setLoadError('Could not load this day. Please check your connection and try again.') })
    return () => { live = false }
  }, [api, date, valid, attempt])

  // Once a hold has started a slide, the finger moves blocks rather than the page. React's touch listeners cannot stop a scroll, so this one is added by hand.
  const loaded = Boolean(rows)
  useEffect(() => {
    const element = list.current
    if (!element) return undefined
    const hold = event => { if (drag.current && event.cancelable) event.preventDefault() }
    element.addEventListener('touchmove', hold, { passive: false })
    return () => element.removeEventListener('touchmove', hold)
  }, [loaded])
  useEffect(() => () => clearTimeout(press.current?.timer), [])

  const paint = useCallback((minutes, value) => {
    setError(''); setWhy(''); setHeld(null); setDiscarding(false)
    setEdits(previous => ({ ...previous, [minutes]: value }))
  }, [])

  if (!valid) return <section className="admin-review admin-day-grid" aria-labelledby="day-grid-title">
    <h1 id="day-grid-title">Edit hours</h1>
    <p role="alert">That is not a date. Go back and choose a day.</p>
  </section>

  const full = dateLabel(date, { weekday: 'long', day: 'numeric', month: 'long' })
  const past = date < today()
  const shown = rows && applyEdits(rows, edits)
  const changes = shown ? changeCount(shown) : 0
  const { from, to, moreEarlier, moreLater } = rows ? visibleRange(rows, range) : {}
  const visible = shown && withLabels(shown.filter(row => row.start_minutes >= from && row.start_minutes < to))
  const dayOff = shown && isDayOff(shown)
  const savedDayOff = rows && isDayOff(rows)

  function down(event, row) {
    if (past || busy) return
    if (row.locked) { setWhy(LOCKED_WHY[row.locked]); return }
    // A finger keeps its first block to itself unless it is let go, and then the blocks it slides over can be found.
    try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch { /* Nothing was captured. */ }
    if (event.pointerType !== 'touch') {
      drag.current = { value: !row.open }
      paint(row.start_minutes, !row.open)
      return
    }
    // A finger may be starting a scroll: it changes the block when it lifts (a tap) or after a short hold (the start of a slide), not when it lands.
    clearTimeout(press.current?.timer)
    const value = !row.open
    press.current = { minutes: row.start_minutes, value, x: event.clientX, y: event.clientY, timer: setTimeout(() => {
      press.current = null
      drag.current = { value }
      paint(row.start_minutes, value)
      navigator.vibrate?.(10)
    }, HOLD_MS) }
  }
  function move(event) {
    const pending = press.current
    if (pending && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 10) forget()
    if (!drag.current) return
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-minutes]')
    if (!cell) return
    const row = shown.find(item => item.start_minutes === Number(cell.dataset.minutes))
    if (row && !row.locked && row.open !== drag.current.value) paint(row.start_minutes, drag.current.value)
  }
  function forget() { clearTimeout(press.current?.timer); press.current = null }
  function up() {
    const pending = press.current
    forget()
    if (pending) paint(pending.minutes, pending.value)
    drag.current = null
  }
  // The browser took the finger to scroll, so nothing changes.
  function stop() { forget(); drag.current = null }
  // A tap is handled when the finger goes down; a click without a pointer (Enter or Space) toggles from the keyboard.
  function click(event, row) {
    if (event.detail !== 0 || past || busy) return
    if (row.locked) setWhy(LOCKED_WHY[row.locked])
    else paint(row.start_minutes, !row.open)
  }

  function toggleDayOff() {
    setError(''); setWhy(''); setHeld(null)
    setEdits(dayOff ? {} : closeAll(rows))
  }
  function cancel() {
    if (changes && !discarding) { setDiscarding(true); return }
    done?.()
  }
  async function save(closeHeld = false) {
    if (busy || !changes || past) return
    setBusy(true); setError(''); setWhy('')
    try {
      const result = await api.saveDayGrid(date, openMinutes(shown), closeHeld)
      if (!result.saved) { setHeld(result.held); return }
      changed?.()
      toast(`Saved · ${dateLabel(date)}`)
      done?.()
    } catch (failure) {
      setError(failure.message)
      // The day changed while it was being edited: read it again, keeping the taps that still apply.
      if (failure.code === '55000') setAttempt(value => value + 1)
    } finally { setBusy(false) }
  }

  return <section className="admin-review admin-day-grid" aria-labelledby="day-grid-title">
    <div className="admin-day-grid-head">
      <div>
        <h1 id="day-grid-title" ref={heading} tabIndex={-1}>Edit hours</h1>
        <p className="admin-day-grid-date">{full}</p>
        {shown && <p className="admin-day-grid-summary" aria-live="polite">{hoursSummary(shown)}</p>}
      </div>
      <button type="button" className="btn--small" disabled={busy} onClick={cancel}>Cancel</button>
    </div>

    {loadError && !rows && <div role="alert" className="error"><p>{loadError}</p><button className="btn--small" onClick={() => setAttempt(value => value + 1)}>Try again</button></div>}
    {!rows && !loadError && <div className="skeleton-rows" role="status"><span className="sr-only">Loading this day…</span><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>}

    {rows && <>
      {past
        ? <p className="admin-detail-hint">This day has passed, so its hours cannot be changed.</p>
        : <div className="admin-day-grid-off">
          <div>
            <span id="day-grid-off-label" className="admin-day-grid-off-title">Day off</span>
            <span className="admin-detail-hint">{dayOff
              ? (shown.some(row => row.locked === 'booking') ? 'Your bookings stay as they are.' : savedDayOff ? 'Tap the half hours you want to work.' : 'The whole day is closed.')
              : 'Close the whole day.'}</span>
          </div>
          <button type="button" role="switch" aria-checked={dayOff} aria-labelledby="day-grid-off-label" className="admin-day-grid-switch"
            disabled={busy || (dayOff && savedDayOff)} onClick={toggleDayOff}><span aria-hidden="true" /></button>
        </div>}

      {moreEarlier && <button type="button" className="btn--quiet admin-day-grid-more" onClick={() => setRange(value => ({ ...value, earlier: true }))}>Show earlier</button>}
      <ol role="list" className="admin-day-grid-list" aria-label={`Half hours on ${full}`} ref={list}
        onPointerMove={move} onPointerUp={up} onPointerCancel={stop} onPointerLeave={stop}>
        {visible.map(row => <li key={row.start_minutes}>
          <span className="admin-day-grid-time" aria-hidden="true">{clock(row.start_minutes)}</span>
          <button type="button" data-minutes={row.start_minutes} aria-pressed={row.open}
            aria-label={`${clock(row.start_minutes)} to ${clock(row.start_minutes + 30)}, ${row.locked === 'booking' ? `booking${row.label ? `, ${row.label}` : ''}`
              : row.locked === 'travel' ? 'travel time' : row.locked === 'block' ? (row.label || 'blocked time') : row.open ? 'working' : 'not working'}${row.held ? ', a client is booking this time' : ''}`}
            className={['admin-day-grid-cell', row.open ? 'is-open' : 'is-closed', row.locked && `is-${row.locked}`, row.changed && 'is-changed', row.held && 'is-held'].filter(Boolean).join(' ')}
            disabled={past} onPointerDown={event => down(event, row)} onClick={event => click(event, row)}
            onContextMenu={event => event.preventDefault()}>
            <span>{row.locked === 'travel' ? (row.showLabel || 'Travel') : row.showLabel || (row.held && !row.locked ? 'A client is booking' : '')}</span>
          </button>
        </li>)}
      </ol>
      {moreLater && <button type="button" className="btn--quiet admin-day-grid-more" onClick={() => setRange(value => ({ ...value, later: true }))}>Show later</button>}
      {!past && <p className="admin-detail-hint admin-day-grid-hint">Tap a block to change it. To change several, hold one for a moment, then slide down.</p>}

      {why && <p role="status" className="admin-detail-hint admin-day-grid-why">{why}</p>}
      {held && <div role="alert" className="admin-conflicts">
        <p><strong>A client is booking {heldLine(held)} right now.</strong> If you close it, their booking will not go through when they confirm.</p>
        <div className="admin-payment-buttons">
          <button type="button" disabled={busy} onClick={() => setHeld(null)}>Keep it open</button>
          <button type="button" className="btn--danger-solid" disabled={busy} onClick={() => save(true)}>{busy ? 'Saving…' : 'Close it anyway'}</button>
        </div>
      </div>}
      {discarding && <div role="alert" className="admin-conflicts">
        <p>Discard {changes === 1 ? 'your change' : `your ${changes} changes`}? This day stays as it was.</p>
        <div className="admin-payment-buttons">
          <button type="button" onClick={() => setDiscarding(false)}>Keep editing</button>
          <button type="button" className="btn--danger-solid" onClick={cancel}>Discard</button>
        </div>
      </div>}
      {error && <p role="alert" className="error">{error}</p>}

      {!past && <div className="admin-day-grid-actions">
        <button type="button" className="admin-day-grid-save btn--lg btn--block" disabled={busy || !changes || Boolean(held)} onClick={() => save()}>
          {busy ? 'Saving…' : changes ? `Save ${changes} change${changes === 1 ? '' : 's'}` : 'Save'}</button>
      </div>}
    </>}
  </section>
}
