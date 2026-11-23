import { bookingState, shiftDate, time } from './calendarPresentation.js'
import { dayContext } from './calendarPresentation.js'
import { listedBookings } from './cancelledBookings.js'
import { weekdayOf } from './scheduleApi.js'

// The Week and Month views of the Admin Calendar (ADR-112), worked out here so the screens only draw. Nothing here reads the database or the clock:
// the day today and the minute now are passed in.

// Which calendar view was used last on this device (Calendar in the bottom bar opens it), and the View options ticks.
export const VIEW_KEY = 'vad-admin-calendar-view'
export const OPTIONS_KEY = 'vad-admin-calendar-options'
export const ROW_KEY = 'vad-admin-month-row'
export const VIEWS = ['day', 'week', 'month', 'agenda']
export const DEFAULT_OPTIONS = { daysOff: true, travel: false, blocked: true, hoursOnly: false }
const store = {
  read(key) { try { return localStorage.getItem(key) } catch { return null } },
  write(key, value) { try { localStorage.setItem(key, value) } catch { /* A convenience only. */ } },
}
export const readLastView = () => { const value = store.read(VIEW_KEY); return VIEWS.includes(value) ? value : 'agenda' }
export const writeLastView = view => { if (VIEWS.includes(view)) store.write(VIEW_KEY, view) }
export function readOptions() {
  try { const saved = JSON.parse(store.read(OPTIONS_KEY) || '{}'); return Object.fromEntries(Object.entries(DEFAULT_OPTIONS).map(([key, value]) => [key, typeof saved[key] === 'boolean' ? saved[key] : value])) } catch { return { ...DEFAULT_OPTIONS } }
}
export const writeOptions = options => store.write(OPTIONS_KEY, JSON.stringify(options))
// How tall a week of the phone's month is, in pixels, set with two fingers. Kept between a compact and a roomy size.
export const ROW_MIN = 64, ROW_MAX = 200, ROW_DEFAULT = 108
export const clampRow = value => Math.round(Math.min(ROW_MAX, Math.max(ROW_MIN, Number(value) || ROW_DEFAULT)))
export const readRowHeight = () => clampRow(store.read(ROW_KEY) ?? ROW_DEFAULT)
export const writeRowHeight = value => store.write(ROW_KEY, String(clampRow(value)))

// UK week numbers (ISO 8601): the week with the year's first Thursday is week 1, and weeks start on Monday.
export function isoWeek(date) {
  const thursday = shiftDate(date, 4 - weekdayOf(date))
  const yearStart = `${thursday.slice(0, 4)}-01-01`
  return Math.floor((Date.parse(thursday) - Date.parse(yearStart)) / 86400000 / 7) + 1
}
export const weekStart = date => shiftDate(date, 1 - weekdayOf(date))
export const monthFirst = date => `${date.slice(0, 7)}-01`
export function shiftMonth(date, months) {
  const [year, month] = date.split('-').map(Number)
  const value = new Date(Date.UTC(year, month - 1 + months, 1, 12))
  return value.toISOString().slice(0, 10)
}
// The month on a grid of six whole weeks, Monday first, so every month takes the same space and the grid never jumps in height.
export function monthGrid(date) {
  const first = monthFirst(date)
  const start = weekStart(first)
  const weeks = []
  for (let week = 0; week < 6; week++) {
    const monday = shiftDate(start, week * 7)
    weeks.push({ number: isoWeek(monday), days: Array.from({ length: 7 }, (_, day) => shiftDate(monday, day)) })
  }
  return { first, month: first.slice(0, 7), start, end: shiftDate(start, 42), weeks }
}
// The days a Week view shows: Monday to Sunday on a computer, or three days from the day chosen on a phone.
export const weekDates = (date, narrow) => narrow ? [date, shiftDate(date, 1), shiftDate(date, 2)] : Array.from({ length: 7 }, (_, day) => shiftDate(weekStart(date), day))

// A name short enough for a day square: "Sarah K." on a computer, "Sarah" on a phone. A booking for two or more people says so: "Ruth +1".
export function shortName(booking, { first = false } = {}) {
  const firstName = (booking.clients?.first_name || '').trim()
  const last = (booking.clients?.last_name || '').trim()
  const name = firstName ? (first || !last ? firstName : `${firstName} ${last[0]}.`) : 'No name'
  const people = booking.booking_sessions?.length || 1
  return people > 1 ? `${name} +${people - 1}` : name
}

const GOING_AHEAD = ['confirmed', 'completed', 'awaiting_payment_verification', 'awaiting_cash_approval', 'awaiting_transfer']
export const goingAhead = booking => GOING_AHEAD.includes(booking.booking_status)
const SETTLED = ['paid', 'approved', 'refunded']
// Where a booking stands, as one colour: ok = paid, wait = money still to come before the visit, owed = the visit is over and the money has not come,
// needs = something for the Admin to check or confirm, cancel and noshow = it did not happen. The words beside it always say it too.
export function bookingTone(booking, todayDate, nowMinutes) {
  const state = bookingState(booking)
  if (state.chip === 'cancel' || state.chip === 'noshow') return state.chip
  if (state.chip === 'needs' || state.pills?.[0]?.chip === 'needs' || state.pills?.[1]?.chip === 'needs') return 'needs'
  const payment = booking.booking_payments?.status
  const balance = Number(booking.balance_due_gbp) || 0
  if (SETTLED.includes(payment) && balance <= 0) return 'ok'
  const end = booking.start_minutes + booking.treatment_duration_minutes
  const over = booking.date < todayDate || (booking.date === todayDate && end <= nowMinutes)
  return over ? 'owed' : 'wait'
}
// The short word on a line that is not just paid: the colour never carries the meaning alone.
export const TONE_WORD = { ok: '', wait: '', needs: 'to check', owed: 'unpaid', cancel: 'cancelled', noshow: 'no show' }
export const TONE_LABEL = { ok: 'paid', wait: 'payment awaited', needs: 'to check', owed: 'session done, not paid', cancel: 'cancelled', noshow: 'no show' }

const isAllDay = row => row.start_minutes === 0 && row.end_minutes === 1440
const blockName = row => row.title || (row.kind === 'personal_event' ? 'Personal event' : 'Blocked time')
// Time away: a block over several days, or over a whole day. Every day it covers says so, and which day of it it is.
function awayDays(blocks) {
  const groups = new Map()
  for (const row of blocks) groups.set(row.group_id ?? row.id, [...(groups.get(row.group_id ?? row.id) || []), row])
  const away = new Map()
  for (const rows of groups.values()) {
    const dates = [...new Set(rows.map(row => row.date))].sort()
    if (dates.length < 2 && !rows.some(isAllDay)) continue
    const title = rows[0].kind === 'personal_event' ? blockName(rows[0]) : `Away${rows[0].title ? ` · ${rows[0].title}` : ''}`
    dates.forEach((date, index) => away.set(date, { title, number: index + 1, total: dates.length, ids: rows.map(row => row.id) }))
  }
  return away
}

// Everything a Month or Week view needs to know about each day it shows, from one read of the calendar (loadCalendarRange):
// its hours (special or usual, or a day off), whether it is time away, its entries in time order, and how full it is (booked, travel and
// blocked time against the working hours, 0 to 1). Cancelled bookings are left out unless asked for, as in Day and Agenda.
export function calendarDays(data, dates, { showCancelled = false, blocked = true } = {}, todayDate, nowMinutes, now = Date.now()) {
  const timedBlocks = (data.blocks || []).filter(row => row.kind === 'blocked' || row.kind === 'personal_event')
  const away = awayDays(timedBlocks)
  const days = new Map()
  for (const date of dates) {
    const hours = (data.dayHours || []).find(row => row.date === date) || null
    const bookings = listedBookings((data.bookings || []).filter(row => row.date === date), showCancelled)
    const dayBlocks = (data.blocks || []).filter(row => row.date === date)
    const awayHere = away.get(date) || null
    const entries = [
      ...bookings.map(booking => ({ kind: 'booking', id: booking.id, start: booking.start_minutes, end: booking.start_minutes + booking.treatment_duration_minutes, booking, tone: bookingTone(booking, todayDate, nowMinutes) })),
      ...(blocked ? timedBlocks.filter(row => row.date === date && !awayHere?.ids.includes(row.id)).map(row => ({ kind: 'block', id: row.id, start: row.start_minutes, end: row.end_minutes, block: row, title: blockName(row) })) : []),
      ...(data.offers || []).filter(row => row.date === date).map(offer => ({ kind: 'offer', id: offer.id, start: offer.start_minutes, end: offer.start_minutes + offer.duration_minutes, offer })),
    ].sort((a, b) => a.start - b.start || (a.kind === 'booking' ? -1 : 1))
    const open = hours?.available && hours.end_minutes > hours.start_minutes
    let full = 0
    if (open) {
      const context = dayContext({ dayHours: [hours], blocks: dayBlocks, bookings: (data.bookings || []).filter(row => row.date === date), holds: (data.holds || []).filter(row => row.date === date) }, date, now)
      const free = context.gaps.reduce((sum, [start, end]) => sum + Math.max(0, end - start), 0)
      full = Math.min(1, Math.max(0, 1 - free / (hours.end_minutes - hours.start_minutes)))
    }
    const booked = bookings.filter(goingAhead).length
    days.set(date, { date, hours, open: Boolean(open) && !awayHere, special: hours?.source === 'special' && Boolean(hours.available), away: awayHere, entries, booked, full: awayHere ? 0 : full })
  }
  return days
}

// The hours of a day in a few words for its square: "14:30–19:00", "Special 12:00–16:00", "Day off".
export function hoursWords(day) {
  if (day.away) return ''
  if (!day.hours?.available) return 'Day off'
  const span = `${time(day.hours.start_minutes)}–${time(day.hours.end_minutes)}`
  return day.special ? `Special ${span}` : span
}

// A weekday is left out of the grid ("Days off" unticked) only where every one of its days on show is a day off with nothing on it, so nothing
// booked can ever be hidden.
export function hiddenWeekdays(days, dates, showDaysOff) {
  if (showDaysOff) return new Set()
  const hidden = new Set()
  for (let weekday = 1; weekday <= 7; weekday++) {
    const ofDay = dates.filter(date => weekdayOf(date) === weekday)
    if (ofDay.length && ofDay.every(date => { const day = days.get(date); return day && !day.open && !day.entries.length })) hidden.add(weekday)
  }
  return hidden.size === 7 ? new Set() : hidden
}

// The month's line under its name: "18 sessions · 6 working days still free" (from today on; a month gone by counts only its sessions).
export function monthSummary(days, month, todayDate) {
  let sessions = 0, freeDays = 0
  for (const day of days.values()) {
    if (!day.date.startsWith(month)) continue
    sessions += day.booked
    if (day.open && day.date >= todayDate && !day.booked) freeDays++
  }
  const words = [`${sessions} ${sessions === 1 ? 'session' : 'sessions'}`]
  if (month >= todayDate.slice(0, 7)) words.push(`${freeDays} working ${freeDays === 1 ? 'day' : 'days'} still free`)
  return words.join(' · ')
}

// The hours a Week view's time grid covers: from the earliest working hour or entry to the latest, in whole hours (9:00 to 18:00 when there is none),
// so a phone does not scroll through empty mornings.
export function weekSpan(days, rowsByDate = new Map()) {
  let from = Infinity, to = -Infinity
  for (const day of days) {
    if (day.hours?.available && !day.away) { from = Math.min(from, day.hours.start_minutes); to = Math.max(to, day.hours.end_minutes) }
    for (const row of [...day.entries, ...(rowsByDate.get(day.date) || [])]) { from = Math.min(from, row.start); to = Math.max(to, row.end) }
  }
  if (from === Infinity) return { from: 9 * 60, to: 18 * 60 }
  return { from: Math.max(0, Math.floor(from / 60) * 60), to: Math.min(1440, Math.max(Math.ceil(to / 60) * 60, Math.floor(from / 60) * 60 + 120)) }
}

// Where an entry sits on the Week grid. Entries that overlap (a cancelled booking under a new one) share the width side by side.
export function placeColumns(rows) {
  const placed = rows.map(row => ({ ...row, lane: 0, lanes: 1 }))
  const sorted = [...placed].sort((a, b) => a.start - b.start || b.end - a.end)
  let cluster = [], clusterEnd = -1
  const close = () => { const lanes = Math.max(1, ...cluster.map(row => row.lane + 1)); for (const row of cluster) row.lanes = lanes; cluster = [] }
  for (const row of sorted) {
    if (row.start >= clusterEnd && cluster.length) close()
    const used = new Set(cluster.filter(other => other.end > row.start).map(other => other.lane))
    let lane = 0; while (used.has(lane)) lane++
    row.lane = lane
    cluster.push(row)
    clusterEnd = Math.max(clusterEnd, row.end)
  }
  if (cluster.length) close()
  return placed
}

// Read a range of more than 31 days (the most one read may ask for) in pieces, and put the pieces back together.
export function rangePieces(start, end, size = 31) {
  const pieces = []
  for (let from = start; from < end; from = shiftDate(from, size)) {
    const to = shiftDate(from, size)
    pieces.push([from, to < end ? to : end])
  }
  return pieces
}
export function mergeRanges(parts) {
  const byId = list => [...new Map(list.filter(Boolean).map(row => [row.id ?? `${row.date}`, row])).values()]
  return {
    bookings: byId(parts.flatMap(part => part.bookings || [])),
    blocks: byId(parts.flatMap(part => part.blocks || [])),
    dayHours: [...new Map(parts.flatMap(part => part.dayHours || []).map(row => [row.date, row])).values()],
    holds: byId(parts.flatMap(part => part.holds || [])),
    offers: byId(parts.flatMap(part => part.offers || [])),
  }
}
