import { useSyncExternalStore } from 'react'
import { dateLabel, shiftDate } from './calendarPresentation.js'

// "Not yet": a payment the Admin cannot settle yet is put off until a time the Admin chooses. Nothing about the booking or the client changes, so the
// reminder is kept on this device only. If the device ever forgets it, the payment simply comes back into "Needs you", which is the safe way to be wrong.
const KEY = 'vad-admin-payment-reminders'
const MORNING = 9 * 60
const MINUTE = 60000
const HOUR = 60 * MINUTE

const londonParts = instant => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant).map(part => [part.type, part.value]))
export const londonDateOf = instant => { const parts = londonParts(instant); return `${parts.year}-${parts.month}-${parts.day}` }
export const londonClock = instant => { const parts = londonParts(instant); return `${parts.hour}:${parts.minute}` }

// The moment a London wall-clock time happens on a date, on either side of the clocks changing.
export function londonInstant(date, minutes) {
  const [year, month, day] = date.split('-').map(Number)
  const wall = Date.UTC(year, month - 1, day, 0, minutes)
  const offset = at => { const parts = londonParts(at); return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)) - Math.floor(at / MINUTE) * MINUTE }
  return wall - offset(wall - offset(wall))
}

const shortDate = date => dateLabel(date, { weekday: 'short', day: 'numeric', month: 'short' })

// When the appointment starts.
export const startOf = booking => londonInstant(booking.date, booking.start_minutes)

// When a reminder can be set: in three hours, tomorrow morning, or the morning before the appointment. Never after the appointment has started,
// because that is when the decision matters, and only the choices that are still ahead.
export function reminderChoices(booking, now = Date.now()) {
  const starts = startOf(booking)
  const ahead = starts > now
  const here = londonDateOf(now)
  const tomorrow = londonInstant(shiftDate(here, 1), MORNING)
  const before = londonInstant(shiftDate(booking.date, -1), MORNING)
  const all = [
    { key: 'hours', until: now + 3 * HOUR, label: `In 3 hours · ${londonClock(now + 3 * HOUR)}` },
    { key: 'tomorrow', until: tomorrow, label: `Tomorrow morning · ${shortDate(shiftDate(here, 1))}, 09:00` },
    { key: 'before', until: before, label: `The day before · ${shortDate(shiftDate(booking.date, -1))}, 09:00` },
  ]
  const fits = choice => choice.until >= now + MINUTE && (!ahead || choice.until <= starts)
  const choices = all.filter(choice => fits(choice) && (choice.key !== 'before' || choice.until > tomorrow))
  if (choices.length) return choices
  // The appointment is close, so the only useful reminder is a short one, and at the latest when it starts.
  if (ahead && starts - now <= 30 * MINUTE) return [{ key: 'soon', until: starts, label: `When it starts · ${londonClock(starts)}` }]
  return [{ key: 'soon', until: now + 30 * MINUTE, label: `In 30 minutes · ${londonClock(now + 30 * MINUTE)}` }]
}

// "today, 16:25", "tomorrow, 09:00", or the day.
export function reminderWhen(until, now = Date.now()) {
  const day = londonDateOf(until)
  const here = londonDateOf(now)
  const name = day === here ? 'today' : day === shiftDate(here, 1) ? 'tomorrow' : shortDate(day)
  return `${name}, ${londonClock(until)}`
}

// A reminder belongs to the booking as it was when it was set: any change to the booking or its payment (the client declaring again, say) ends it.
export const fingerprint = booking => `${booking.updated_at}|${booking.booking_payments?.updated_at}`

export function parseReminders(raw) {
  const saved = {}
  if (!raw || typeof raw !== 'object') return saved
  for (const [id, value] of Object.entries(raw)) if (value && Number.isFinite(value.until) && typeof value.seen === 'string') saved[id] = { until: value.until, seen: value.seen }
  return saved
}

export function activeReminder(booking, saved, now = Date.now()) {
  const found = saved?.[booking.id]
  return found && found.until > now && found.seen === fingerprint(booking) ? found : null
}

function read() {
  try { return parseReminders(JSON.parse(localStorage.getItem(KEY) || '{}')) } catch { return {} }
}
let reminders = read()
const listeners = new Set()
const announce = () => listeners.forEach(listener => listener())
function commit(next) {
  reminders = next
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* Kept for this visit only; the payment comes back by itself. */ }
  announce()
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => { if (event.key === KEY || event.key === null) { reminders = read(); announce() } })

export const getReminders = () => reminders
export const subscribeReminders = listener => { listeners.add(listener); return () => listeners.delete(listener) }
// Every screen that shows the payments reads the reminders through this, so putting one off changes them all at once.
export const useReminders = () => useSyncExternalStore(subscribeReminders, getReminders, () => ({}))

export function setReminder(booking, until, now = Date.now()) {
  const live = Object.fromEntries(Object.entries(reminders).filter(([, value]) => value.until > now))
  commit({ ...live, [booking.id]: { until, seen: fingerprint(booking) } })
}
export function clearReminder(id) {
  if (!reminders[id]) return
  const rest = { ...reminders }
  delete rest[id]
  commit(rest)
}
