// The row of days above the times: five days at a time, with the calendar behind a field for anything further.
export const STRIP_DAYS = 5

export function addDays(date, days) {
  const moved = new Date(`${date}T12:00:00Z`)
  moved.setUTCDate(moved.getUTCDate() + days)
  return moved.toISOString().slice(0, 10)
}

export const stripFrom = (start, count = STRIP_DAYS) => Array.from({ length: count }, (_, index) => addDays(start, index))

// Where the row may start: never before today, and never so late that days past the booking limit are shown.
export function clampStrip(start, today, last, count = STRIP_DAYS) {
  const latestStart = addDays(last, -(count - 1))
  const bounded = start > latestStart ? latestStart : start
  return bounded < today ? today : bounded
}

export function dayParts(date) {
  const at = new Date(`${date}T12:00:00Z`)
  const part = options => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', ...options }).format(at)
  return { weekday: part({ weekday: 'short' }), day: part({ day: 'numeric' }), month: part({ month: 'short' }), long: part({ weekday: 'long', day: 'numeric', month: 'long' }) }
}
