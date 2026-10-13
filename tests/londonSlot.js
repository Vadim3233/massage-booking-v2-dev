// A London date and a half-hour start `offsetMs` from now, for tests that need a booking just inside or just outside a window of time.
// A booking has to fit in the day it starts on, and a treatment can be two hours: a start in the last two hours of a day is moved
// three hours on (or three back, for a time in the past) so it never runs past midnight, whatever the time the test runs at.
// Beware an offset close to a policy boundary (23 hours for "inside 24"): at night it becomes 26, so use offsets well inside a window.
function at(offsetMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(Date.now() + offsetMs)).map(part => [part.type, part.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, start: Math.floor((Number(parts.hour) * 60 + Number(parts.minute)) / 30) * 30 }
}
export function londonSlot(offsetMs) {
  const slot = at(offsetMs)
  return slot.start <= 1440 - 120 ? slot : at(offsetMs + (offsetMs < 0 ? -3 : 3) * 3600000)
}
