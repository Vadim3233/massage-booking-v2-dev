import { useEffect, useRef, useState } from 'react'
import Icon from '../ui/icons.jsx'

// The menu of ticks behind "View options". "Cancelled bookings" is the same choice as Show cancelled in Day and Agenda.
export function ViewOptions({ options, change, showCancelled, setShowCancelled, week, rowSize }) {
  const [open, setOpen] = useState(false)
  const box = useRef(null)
  useEffect(() => {
    if (!open) return
    const away = event => { if (!box.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  const ticks = [
    ['daysOff', 'Days off', 'Untick to leave out days off with nothing on them'],
    ...(week ? [['travel', 'Travel time', 'The drive before and after each visit']] : []),
    ['blocked', 'Blocked time', 'Dentist, personal events, time away'],
  ]
  return <div className="calview-options" ref={box} onKeyDown={event => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); box.current?.querySelector('button')?.focus() } }}>
    <button className="calview-pill" aria-label="View options" aria-expanded={open} aria-controls="calview-options-menu" onClick={() => setOpen(value => !value)}><span>View options</span><Icon name="down" size={16} /></button>
    {open && <div id="calview-options-menu" className="calview-menu">
      <p className="calview-menu-title">Show on the calendar</p>
      {ticks.map(([key, text, sub]) => <label key={key} className="calview-tick">
        <input type="checkbox" checked={options[key]} onChange={event => change(key, event.target.checked)} />
        <span><span>{text}</span><small>{sub}</small></span>
      </label>)}
      <label className="calview-tick">
        <input type="checkbox" checked={showCancelled} onChange={event => setShowCancelled(event.target.checked)} />
        <span><span>Cancelled bookings</span><small>Shown crossed out, the same as in Day and Agenda</small></span>
      </label>
      {rowSize && <div className="calview-rowsize">
        <span>Day size</span>
        <button aria-label="Smaller days" onClick={() => rowSize(-24)}><Icon name="minus" size={18} /></button>
        <button aria-label="Bigger days" onClick={() => rowSize(24)}><Icon name="plus" size={18} /></button>
      </div>}
      <p className="calview-menu-note">Kept on this device.{rowSize ? ' Pinch the month with two fingers to change the day size too.' : ' Keys: T for today, ← → to move.'}</p>
    </div>}
  </div>
}

// "Hours only": everything is hidden but each day's working hours, so they can be read at a glance.
export function HoursOnlySwitch({ on, change }) {
  return <button className="calview-pill calview-hours-only" aria-label="Hours only" aria-pressed={on} onClick={() => change('hoursOnly', !on)}><Icon name="clock" size={16} /><span>Hours only</span></button>
}

export function LoadState({ data, failed, retry, label }) {
  if (failed) return <div role={data ? 'status' : 'alert'} className="error calview-error"><p>{data ? 'Could not refresh the calendar just now.' : 'Could not load the calendar. Please check your connection and try again.'}</p><button className="btn--small" onClick={retry}>{data ? 'Try again' : 'Retry calendar'}</button></div>
  if (!data) return <div className="skeleton-rows" role="status" aria-label={label}><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>
  return null
}
