import { useEffect, useState } from 'react'
import { timeLabel } from '../../client/booking/bookingDraft.js'
import { groupSlots } from '../../client/booking/timeOfDay.js'
import { shiftDate, time, today } from '../calendarPresentation.js'
import { dayInWords } from './presentation.js'
import { clashNote, CLIENT_BOOKING_NOTE } from './times.js'

const message = error => (error?.code === 'PGRST202' || /schema cache/i.test(error?.message || '') ? 'Recording an appointment that has already happened is not ready yet.' : error?.message || 'Something went wrong. Please retry.')
const span = item => `${time(item.start)}–${time(item.end)}`
const whoIs = item => (item.kind === 'hold' ? '(a client is booking)' : item.label || 'an appointment')

// "It has already happened": the day it was, and every half hour of that day that has begun, for an appointment she is putting in the diary
// after the fact (up to a year back). Working hours and the usual gap mean nothing for something that has happened, so every time is open
// except one that overlaps another appointment: that one is greyed, and tapping it says what it clashes with. It looks as the usual picker does.
export default function PastTimes({ date, duration, selectedStart, onPick, onDate, loadTimes, reloadKey = 0 }) {
  const earliest = shiftDate(today(), -365)
  const latest = today()
  const inRange = Boolean(date) && date >= earliest && date <= latest
  const [state, setState] = useState(null)
  const [refused, setRefused] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const key = `${date}:${duration}:${attempt}:${reloadKey}`
  useEffect(() => {
    if (!inRange) return undefined
    let live = true
    loadTimes(date, duration).then(day => { if (live) setState({ key, day, error: '' }) }, failure => { if (live) setState({ key, day: null, error: message(failure) }) })
    return () => { live = false }
  }, [inRange, key, date, duration, loadTimes])
  const current = state?.key === key ? state : null
  const day = current?.day

  // The note about a time that overlaps belongs to the day it was tapped on: choosing another time, or another day, takes it away.
  function choose(slot) {
    if (slot.clash) {
      setRefused({ start: slot.start, text: clashNote(slot.start, duration, day) })
      return
    }
    setRefused(null)
    onPick(date, slot.start)
  }

  return <div className="dtp anb-alltimes anb-past">
    <label className="date-field">Day it happened
      <input type="date" value={inRange ? date : ''} min={earliest} max={latest} onClick={event => {
        try { event.currentTarget.showPicker?.() } catch { /* Keep native date entry available when the browser restricts showPicker. */ }
      }} onChange={event => { const value = event.target.value; if (value && value >= earliest && value <= latest) { setRefused(null); onDate(value) } }} />
    </label>
    {inRange && <p className="day-name">{dayInWords(date)}</p>}
    {!inRange && <p className="anb-hint">Choose the day it happened: any day in the last year, up to today.</p>}
    {inRange && !current && <p role="status">Loading the times…</p>}
    {inRange && current?.error && <div role="alert"><p>{current.error}</p><button type="button" className="btn--small" onClick={() => setAttempt(value => value + 1)}>Try again</button></div>}
    {inRange && day && <>
      <p className="anb-hint">{day.booked.length ? `In your diary that day: ${day.booked.map(item => `${span(item)} ${whoIs(item)}`).join(', ')}.` : 'Nothing was in your diary that day.'}
        {' '}Any time can be chosen except one that overlaps another appointment (greyed).</p>
      {day.client_booking && <p className="anb-time-note">{CLIENT_BOOKING_NOTE}</p>}
      {day.slots.length === 0 && <p className="anb-hint">No time of that day has begun yet.</p>}
      {day.slots.length > 0 && <div role="group" aria-label="Times it could have happened">
        {groupSlots(day.slots.map(slot => slot.start)).map(group => <div key={group.key}>
          <h3 className="slot-group">{group.label}</h3>
          <div className="slots">{group.slots.map(start => {
            const slot = day.slots.find(item => item.start === start)
            return <button type="button" key={start} aria-pressed={selectedStart === start} aria-disabled={slot.clash ? 'true' : undefined} onClick={() => choose(slot)}>
              {timeLabel(start)}{slot.clash && <span className="sr-only"> overlaps another appointment</span>}</button>
          })}</div>
          {refused && group.slots.includes(refused.start) && <p className="anb-time-note anb-time-note--refused">{refused.text}</p>}
        </div>)}
      </div>}
    </>}
    {/* Said aloud to a screen reader when it changes; the same words are shown under the times. */}
    <p className="sr-only" role="status">{refused ? refused.text : ''}</p>
  </div>
}
