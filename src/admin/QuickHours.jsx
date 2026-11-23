import { useEffect, useRef, useState } from 'react'
import { clock, scheduleApi, timeOptions } from './scheduleApi.js'
import { heldLine } from './dayGrid.js'
import { quickPlan } from './quickHours.js'
import { dateLabel } from './calendarPresentation.js'
import { toast } from '../ui/toast.js'
import Icon from '../ui/icons.jsx'

const WIDTH = 300

// Change a day's hours straight from Hours only (ADR-112): From and To drop-downs, or Day off, and Save. On a computer it opens beside the hours
// tapped; on a phone it rises from the bottom. "More options" opens the full Edit hours grid for breaks and the rest.
export default function QuickHours({ date, hours, anchor, narrow, close, saved, openFull, api = scheduleApi }) {
  const [rows, setRows] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const working = Boolean(hours?.available)
  const [start, setStart] = useState(working ? hours.start_minutes : 600)
  const [end, setEnd] = useState(working ? hours.end_minutes : 1080)
  const [dayOff, setDayOff] = useState(!working)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [held, setHeld] = useState(null)
  const box = useRef(null)
  const first = useRef(null)

  useEffect(() => {
    let live = true
    api.dayGrid(date).then(result => { if (live) { setRows(result); setLoadError('') } }, () => { if (live) setLoadError('Could not load this day. Please check your connection and try again.') })
    return () => { live = false }
  }, [api, date, attempt])
  useEffect(() => { first.current?.focus() }, [])

  const plan = rows && quickPlan(rows, dayOff ? null : start, dayOff ? null : end)
  const ends = timeOptions(true).filter(minutes => minutes > start)
  const pickStart = value => { setStart(value); if (end <= value) setEnd(Math.min(1440, value + 60)); setError(''); setHeld(null) }

  async function save(closeHeld = false) {
    if (busy || !plan || plan.blocked) return
    if (plan.unchanged) { close(); return }
    setBusy(true); setError('')
    try {
      const result = await api.saveDayGrid(date, plan.open, closeHeld)
      if (!result.saved) { setHeld(result.held); return }
      toast(`Saved · ${dateLabel(date)} ${result.available ? `${clock(result.start_minutes)}–${clock(result.end_minutes)}` : 'day off'}`)
      saved()
    } catch (failure) {
      setError(failure.message)
      if (failure.code === '55000') setAttempt(value => value + 1)
    } finally { setBusy(false) }
  }

  // On a computer, beside the hours tapped and kept on the screen.
  const place = !narrow && anchor ? {
    position: 'fixed', width: `${WIDTH}px`,
    left: `${Math.max(8, Math.min(anchor.left, window.innerWidth - WIDTH - 8))}px`,
    top: `${anchor.bottom + 300 > window.innerHeight ? Math.max(8, anchor.top - 300) : anchor.bottom + 6}px`,
  } : undefined
  const keys = event => {
    if (event.key === 'Escape') { event.stopPropagation(); close() }
    if (event.key !== 'Tab') return
    const items = [...box.current.querySelectorAll('button:not(:disabled), select:not(:disabled), input:not(:disabled)')]
    if (!items.length) return
    if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus() }
    else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus() }
  }

  return <div className={`calview-sheet-backdrop calview-quick-backdrop ${narrow ? '' : 'is-popover'}`} onClick={close}>
    <section ref={box} className={`calview-quick ${narrow ? 'calview-sheet' : ''}`} style={place} role="dialog" aria-modal="true" aria-labelledby="calview-quick-title" onClick={event => event.stopPropagation()} onKeyDown={keys}>
      <div className="calview-sheet-head">
        <h2 id="calview-quick-title">{dateLabel(date, { weekday: 'short', day: 'numeric', month: 'short' })}</h2>
        <button ref={first} className="calview-sheet-close" aria-label="Close" onClick={close}><Icon name="cross" size={20} /></button>
      </div>
      {loadError ? <div role="alert" className="error"><p>{loadError}</p><button className="btn--small" onClick={() => setAttempt(value => value + 1)}>Try again</button></div> : <>
        <div className="calview-quick-times">
          <label><span>From</span>
            <select value={start} disabled={dayOff || busy} onChange={event => pickStart(Number(event.target.value))}>{timeOptions().map(minutes => <option key={minutes} value={minutes}>{clock(minutes)}</option>)}</select>
          </label>
          <label><span>To</span>
            <select value={end} disabled={dayOff || busy} onChange={event => { setEnd(Number(event.target.value)); setError(''); setHeld(null) }}>{ends.map(minutes => <option key={minutes} value={minutes}>{clock(minutes)}</option>)}</select>
          </label>
        </div>
        <label className="calview-tick calview-quick-off">
          <input type="checkbox" checked={dayOff} disabled={busy} onChange={event => { setDayOff(event.target.checked); setError(''); setHeld(null) }} />
          <span><span>Day off</span></span>
        </label>
        {!rows && <p className="calview-quick-note" role="status">Checking the day…</p>}
        {plan?.note && <p className={`calview-quick-note ${plan.blocked ? 'is-warn' : ''}`} role="status">{plan.note}</p>}
        {held && <p className="calview-quick-note is-warn" role="alert">A client is booking {heldLine(held)} right now. Close it anyway?</p>}
        {error && <p className="calview-quick-note is-warn" role="alert">{error}</p>}
        <div className="calview-quick-actions">
          {held
            ? <button className="btn--danger-solid" disabled={busy} onClick={() => save(true)}>{busy ? 'Saving…' : 'Close it anyway'}</button>
            : <button className="btn--primary" disabled={busy || !plan || plan.blocked} onClick={() => save()}>{busy ? 'Saving…' : 'Save'}</button>}
          <button className="btn--quiet calview-open-day" onClick={openFull}>More options</button>
        </div>
      </>}
    </section>
  </div>
}
