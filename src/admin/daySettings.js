import { cleanDay, clock, DEFAULT_HOURS, usualHoursFor } from './scheduleApi.js'

// The bookings that make up a day's run: the same statuses the availability calculation counts.
const IN_THE_RUN = ['awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed', 'completed']

// A date written as YYYY-MM-DD that exists.
export const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value

// What the database holds for one date, read as the Day view reads it: the date's own settings if it has them (a special day), otherwise
// the usual week's. A row from a database that does not have the release time or the schedule mode yet reads as having neither.
export function dayState(date, { overrides = [], hours = [] }) {
  const own = overrides.find(row => row.date === date)
  const usual = usualHoursFor(date, hours)
  return { special: Boolean(own), usual, saved: own ? { ...cleanDay(own), note: own.note || '' } : { ...usual, note: '' } }
}

// "Working 12:00–20:00 · Chain · First appointment 15:00, released 17:00 the day before": what a day's settings come to, in one line.
export function settingsLine(entry) {
  if (!entry.available) return 'Not a working day'
  const first = entry.start_mode === 'fixed'
    ? `First appointment ${clock(entry.fixed_start_minutes)}${entry.anchor_release_minutes != null ? `, released ${clock(entry.anchor_release_minutes)} the day before` : ''}`
    : 'First appointment: any time'
  return `Working ${clock(entry.start_minutes)}–${clock(entry.end_minutes)} · ${entry.schedule_mode === 'flexible' ? 'Flexible' : 'Chain'} · ${first}`
}

// "3 bookings · 13:00–19:00": how many bookings are in the day's run, and from when to when they run.
export function bookingsLine(bookings) {
  const run = bookings.filter(booking => IN_THE_RUN.includes(booking.booking_status))
  if (!run.length) return 'No bookings'
  const from = Math.min(...run.map(booking => booking.start_minutes))
  const to = Math.max(...run.map(booking => booking.start_minutes + booking.treatment_duration_minutes))
  return `${run.length} ${run.length === 1 ? 'booking' : 'bookings'} · ${clock(from)}–${clock(to)}`
}

// A day's settings as they are saved, so two forms can be compared without a day off's leftover times getting in the way.
const values = entry => ({ ...cleanDay(entry), note: (entry.note || '').trim() })
export const isDirty = (saved, form) => JSON.stringify(values(saved)) !== JSON.stringify(values(form))
// Whether the working hours themselves differ, which is what can leave an existing booking outside them.
export function hoursChanged(saved, form) {
  const before = cleanDay(saved)
  const after = cleanDay(form)
  return before.available !== after.available || before.start_minutes !== after.start_minutes || before.end_minutes !== after.end_minutes
}

// A day that is switched back on starts from what its weekday usually is, or from ordinary hours when that weekday is usually off.
export const workingDay = (usual, note = '') => ({ ...(usual.available ? usual : DEFAULT_HOURS), note })
