import { useEffect, useId, useState } from 'react'
import { timeLabel } from '../../client/booking/bookingDraft.js'
import { groupSlots } from '../../client/booking/timeOfDay.js'
import { time } from '../calendarPresentation.js'
import { clashNote, CLIENT_BOOKING_NOTE, unusualNotes } from './times.js'
// Its styles live with the New booking page, which is loaded on demand; moving a booking uses this too, so it brings them along.
import './newBooking.css'

const message = error => error?.message || 'Something went wrong. Please retry.'
const span = item => `${time(item.start)}–${time(item.end)}`
const whoIs = item => (item.kind === 'hold' ? '(a client is booking)' : item.label || 'an appointment')

// "Show all times": every half hour of the day, for the times the booking page would not normally offer (a shorter gap, a longer day, an
// evening, a day off). Usual times look as they do above; the others are dashed and say what is being set aside; a time that would
// overlap another appointment is greyed and says what it clashes with. While a client is part-way through booking that day the unusual
// times are paused too (the database waits for them: it could take away the time held for the client). The note sits under the group of
// times it is about, so it is in sight where she tapped. Only the Admin sees this.
export default function AllTimes({ date, duration, selectedStart, selectedNotes, onPick, loadTimes, reloadKey = 0 }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState(null)
  const [refused, setRefused] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const panel = useId()
  const key = `${date}:${duration}:${attempt}:${reloadKey}`
  useEffect(() => {
    if (!open) return undefined
    let live = true
    loadTimes(date, duration).then(day => { if (live) setState({ key, day, error: '' }) }, failure => { if (live) setState({ key, day: null, error: message(failure) }) })
    return () => { live = false }
  }, [open, key, date, duration, loadTimes])
  const current = state?.key === key ? state : null
  const day = current?.day
  const paused = Boolean(day?.client_booking)
  // A refusal belongs to the time she had chosen when she tapped; choosing anything else takes it away.
  const refusal = refused?.date === date && refused.selected === selectedStart ? refused : null
  // What the note is about: the time she tapped that cannot be chosen, or else the unusual time she chose.
  const noteStart = refusal ? refusal.start : selectedNotes.length > 0 && selectedStart !== null ? selectedStart : null
  const noteText = refusal ? refusal.text : noteStart !== null ? `Outside your usual times. ${selectedNotes.join(' ')}` : ''
  const waits = slot => !slot.usual && paused

  function choose(slot) {
    if (slot.clash || waits(slot)) {
      setRefused({ date, start: slot.start, selected: selectedStart, text: slot.clash ? clashNote(slot.start, duration, day) : CLIENT_BOOKING_NOTE })
      return
    }
    setRefused(null)
    onPick(date, slot.start, slot.usual ? { anyTime: false, notes: [] } : { anyTime: true, notes: unusualNotes(slot.start, duration, day) })
  }
  // Said to a screen reader after the time, since a dashed border is all that shows the difference.
  const spoken = slot => (slot.clash ? 'overlaps another appointment' : waits(slot) ? 'paused while a client is booking' : slot.usual ? '' : 'not a usual time')

  return <div className="anb-alltimes">
    <button type="button" className="btn--tonal btn--small" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(value => !value)}>{open ? 'Hide all times' : 'Show all times'}</button>
    {!open && <p className="anb-hint">Want a time that is not listed: a shorter gap, an evening, a day off? Show every time of the day.</p>}
    <div id={panel} className="dtp" hidden={!open}>
      {open && !current && <p role="status">Loading all the times…</p>}
      {open && current?.error && <div role="alert"><p>{current.error}</p><button type="button" className="btn--small" onClick={() => setAttempt(value => value + 1)}>Try again</button></div>}
      {open && day && <>
        <p className="anb-hint">{day.working.open ? `Your working hours: ${time(day.working.start)}–${time(day.working.end)}.` : 'This is not one of your working days.'}
          {' '}{day.booked.length ? `Already booked: ${day.booked.map(item => `${span(item)} ${whoIs(item)}`).join(', ')}.` : 'Nothing is booked yet.'}
          {day.blocks.length > 0 && ` Blocked: ${day.blocks.map(block => `${span(block)} ${block.title}`).join(', ')}.`}</p>
        <p className="anb-hint">Dashed times are not usual ones. Grey times overlap another appointment{paused ? ', or are paused while a client is booking' : ''}.</p>
        {paused && <p className="anb-time-note">A client is in the middle of booking this day, so times outside the usual ones are paused for a few minutes.</p>}
        {groupSlots(day.slots.map(slot => slot.start)).map(group => <div key={group.key}>
          <h3 className="slot-group">{group.label}</h3>
          <div className="slots">{group.slots.map(start => {
            const slot = day.slots.find(item => item.start === start)
            return <button type="button" key={start} aria-pressed={selectedStart === start} aria-disabled={slot.clash || waits(slot) ? 'true' : undefined} data-usual={slot.usual ? 'yes' : 'no'}
              onClick={() => choose(slot)}>{timeLabel(start)}{spoken(slot) && <span className="sr-only"> {spoken(slot)}</span>}</button>
          })}</div>
          {noteStart !== null && group.slots.includes(noteStart) && (refusal
            ? <p className="anb-time-note anb-time-note--refused">{refusal.text}</p>
            : <div className="anb-time-note"><p><strong>Outside your usual times</strong></p><ul>{selectedNotes.map(note => <li key={note}>{note}</li>)}</ul></div>)}
        </div>)}
      </>}
      {/* Said aloud to a screen reader when it changes; the same words are shown under the times. */}
      <p className="sr-only" role="status">{noteText}</p>
    </div>
  </div>
}
