import { time } from '../calendarPresentation.js'

const range = (from, to) => `${time(from)}–${time(to)}`
const minutes = count => `${count} ${count === 1 ? 'minute' : 'minutes'}`

export const CLIENT_BOOKING_NOTE = 'A client is in the middle of booking this day. Try again in a few minutes.'

// What is in the way of a start time, in plain words, or '' if nothing is. `day` is what the database says about that day
// (admin_booking_times): her working hours, what is booked, what is blocked, and the gap she normally keeps.
export function clashNote(start, duration, day) {
  const end = start + duration
  const hit = day.booked.find(item => start < item.end && item.start < end)
  if (!hit) return ''
  return hit.kind === 'hold'
    ? `Another client is in the middle of booking ${range(hit.start, hit.end)}.`
    : `Clashes with the ${range(hit.start, hit.end)} appointment${hit.label ? ` for ${hit.label}` : ''}.`
}

// Why a time that does not clash is still not one of the usual times: what she is setting aside by choosing it.
export function unusualNotes(start, duration, day) {
  const end = start + duration
  const gap = day.buffer_minutes
  const notes = []
  if (!day.working.open) notes.push('This is not one of your working days.')
  else if (start < day.working.start || end > day.working.end) notes.push(`Outside your working hours (${range(day.working.start, day.working.end)}).`)
  for (const item of day.booked) {
    if (item.end <= start && start - item.end < gap) {
      const wait = start - item.end
      notes.push(`${wait ? `Only ${minutes(wait)} after` : 'Straight after'} the ${time(item.start)} appointment ends (your usual gap is ${minutes(gap)}).`)
    }
    if (item.start >= end && item.start - end < gap) {
      const wait = item.start - end
      notes.push(`${wait ? `Only ${minutes(wait)} before` : 'Straight before'} the ${time(item.start)} appointment starts (your usual gap is ${minutes(gap)}).`)
    }
  }
  for (const block of day.blocks) {
    if (start < block.end && block.start < end) notes.push(`During "${block.title}" (${range(block.start, block.end)}).`)
    // The weekly booking for a repeating client is made at a usual time; an unusual one elsewhere that day can leave that time no longer usual.
    else if (block.series) notes.push(`A repeating client's time (${range(block.start, block.end)}) is kept free this day. A booking at an unusual time may stop that week's repeat.`)
  }
  if (!notes.length) notes.push(day.booked.length ? 'The booking page only offers times just before your first appointment or just after your last one.' : 'Not your usual start time for this day.')
  return notes
}
