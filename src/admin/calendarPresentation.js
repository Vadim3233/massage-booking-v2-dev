export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
export function shiftDate(date, days) { const value = new Date(date + 'T12:00:00Z'); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10) }
export const time = (minutes) => `${Math.floor(minutes / 60).toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}`
export const money = (value) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(value)
export const label = (value) => ({ awaiting_transfer: 'Awaiting transfer', awaiting_payment_verification: 'Awaiting payment verification', awaiting_cash_approval: 'Awaiting cash approval', awaiting_verification: 'Awaiting verification', awaiting_approval: 'Awaiting approval', bank_transfer: 'Bank transfer', no_show: 'No show' }[value] || (value ? value[0].toUpperCase() + value.slice(1).replaceAll('_', ' ') : 'Not recorded'))
export const clientName = (booking) => [booking.clients?.first_name, booking.clients?.last_name].filter(Boolean).join(' ') || 'Name not recorded'
export function dayContext(data, date, now) {
  const hours = data.overrides.find(row => row.date === date) || data.hours.find(row => row.weekday === (new Date(date + 'T12:00:00Z').getUTCDay() || 7))
  const holds = data.holds.filter(row => Date.parse(row.expires_at) > now)
  if (!hours?.available) return { hours, holds, gaps: [] }
  const occupied = [...data.blocks.map(row => [row.start_minutes, row.end_minutes]), ...data.bookings.filter(row => ['confirmed', 'completed', 'awaiting_payment_verification', 'awaiting_cash_approval', 'awaiting_transfer'].includes(row.booking_status)).map(row => [row.start_minutes - row.travel_buffer_minutes, row.start_minutes + row.treatment_duration_minutes + row.travel_buffer_minutes]), ...holds.map(row => [row.start_minutes - row.travel_buffer_minutes, row.start_minutes + row.treatment_duration_minutes + row.travel_buffer_minutes])].sort((a, b) => a[0] - b[0])
  const gaps = []; let cursor = hours.start_minutes
  for (const [start, end] of occupied) { if (start > cursor) gaps.push([cursor, Math.min(start, hours.end_minutes)]); cursor = Math.max(cursor, end); if (cursor >= hours.end_minutes) break }
  if (cursor < hours.end_minutes) gaps.push([cursor, hours.end_minutes])
  return { hours, holds, gaps }
}

export const dateLabel = (date, options = { weekday: 'short', day: 'numeric', month: 'short' }) => new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'Europe/London' }).format(new Date(date + 'T12:00:00Z'))
// "Today", "Tomorrow", or the weekday and date; the year only when it is not this year.
export function dayHeading(date, from = today()) {
  const short = dateLabel(date, { weekday: 'short', day: 'numeric', month: 'short', ...(date.slice(0, 4) === from.slice(0, 4) ? {} : { year: 'numeric' }) })
  if (date === from) return { name: 'Today', rest: dateLabel(date, { weekday: 'short', day: 'numeric', month: 'short' }) }
  if (date === shiftDate(from, 1)) return { name: 'Tomorrow', rest: dateLabel(date, { weekday: 'short', day: 'numeric', month: 'short' }) }
  return { name: short, rest: '' }
}
// The date and the minutes since midnight in London, whatever the phone's own clock zone is.
function londonNow(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(part => [part.type, part.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) }
}
// The appointment that is happening now, or else the next one that is going ahead (not cancelled, finished or missed).
// Bookings are given in date and time order, as the agenda has them.
const GOING_AHEAD = ['confirmed', 'awaiting_payment_verification', 'awaiting_cash_approval', 'awaiting_transfer']
// What a day is worth: the appointments going ahead or done. A cancellation and a no-show are not worth their price.
const WORTH_NOTHING = ['cancelled', 'no_show']
const dayTotal = bookings => bookings.filter(booking => !WORTH_NOTHING.includes(booking.booking_status)).reduce((sum, booking) => sum + Number(booking.total_gbp || 0), 0)
// What a day's heading says: how many appointments were not cancelled, and what the ones that are worth something come to.
export function daySummary(bookings) {
  if (!bookings.length) return 'Free'
  const live = bookings.filter(booking => booking.booking_status !== 'cancelled')
  if (!live.length) return 'All cancelled'
  const total = dayTotal(bookings)
  return `${live.length} ${live.length === 1 ? 'booking' : 'bookings'}${total > 0 ? ` · ${money(total)}` : ''}`
}
// Whether there is still somewhere to travel to: the appointment is going ahead and has not yet ended (London time).
export function canNavigateTo(booking, now = new Date()) {
  if (!GOING_AHEAD.includes(booking.booking_status)) return false
  const { date, minutes } = londonNow(now)
  return booking.date > date || (booking.date === date && booking.start_minutes + booking.treatment_duration_minutes > minutes)
}
export function nextUp(bookings, now = new Date()) {
  const { date, minutes } = londonNow(now)
  const live = bookings.filter(booking => GOING_AHEAD.includes(booking.booking_status))
  const current = live.find(booking => booking.date === date && booking.start_minutes <= minutes && minutes < booking.start_minutes + booking.treatment_duration_minutes)
  if (current) return { id: current.id, now: true }
  const next = live.find(booking => booking.date > date || (booking.date === date && booking.start_minutes > minutes))
  return next ? { id: next.id, now: false } : null
}
// When the treatment ends: its start plus the treatment's own length, as everywhere else in the Admin. The travel time either side of an
// appointment is kept apart (travel_buffer_minutes) and is not part of it, so it is never added here.
export const bookingEnd = booking => booking.start_minutes + booking.treatment_duration_minutes
// What the treatment is called on a card; its length is shown on its own, so it is not repeated here.
export function treatmentName(booking) {
  const sessions = booking.booking_sessions || []
  if (sessions.length === 1) return sessions[0].service_name_snapshot
  return sessions.length ? `${sessions.length} sessions` : 'Appointment'
}
export function sessionSummary(booking) {
  const sessions = booking.booking_sessions || []
  if (sessions.length === 1) return `${sessions[0].service_name_snapshot} · ${sessions[0].duration_minutes} min`
  return `${sessions.length} sessions · ${booking.treatment_duration_minutes} min`
}
// What state a booking is in, in words, and whose turn it is. `chip` picks the colour of its pill: needs = the Admin acts, wait = the client acts,
// ok = settled, done = finished, cancel and noshow = it did not happen. Colour never carries the meaning alone: the words always do. A booking that
// is listed with no payment at all (a clash warning knows only its status) is named by its status alone.
function stateOf(booking) {
  const status = booking.booking_status
  if (status === 'cancelled') return { text: 'Cancelled', tone: 'cancelled', chip: 'cancel' }
  const payment = booking.booking_payments?.status
  const paymentText = payment === 'approved' && booking.booking_payments?.method === 'cash' ? 'Cash approved' : label(payment)
  const named = 'booking_payments' in booking ? `${label(status)} · ${paymentText}` : label(status)
  if (status === 'no_show') return { text: named, tone: 'muted', chip: 'noshow' }
  if (status === 'awaiting_payment_verification' || payment === 'awaiting_verification') return { text: 'Awaiting payment verification', tone: 'pending', chip: 'needs' }
  if (status === 'awaiting_cash_approval' || payment === 'awaiting_approval') return { text: 'Awaiting cash approval', tone: 'pending', chip: 'needs' }
  if (status === 'awaiting_transfer') return { text: 'Awaiting transfer', tone: 'pending', chip: 'wait' }
  const text = named
  if (status === 'completed') return { text, tone: 'confirmed', chip: 'done' }
  if (status === 'confirmed') return { text, tone: 'confirmed', chip: payment === 'awaiting_transfer' ? 'wait' : 'ok' }
  return { text, tone: 'muted', chip: 'wait' }
}
// The colour a booking is drawn in, the same in every list: sage = settled, sand = waiting on money or on the Admin, and the others as they always were.
const VARIANT = { ok: 'sage', needs: 'sand', wait: 'sand', done: 'completed', cancel: 'cancelled', noshow: 'noshow' }
export function bookingState(booking) {
  const state = stateOf(booking)
  return { ...state, variant: VARIANT[state.chip] }
}
// The two things every view takes from here, so no view keeps its own copy of the rules: the words of a booking's pill, and the colour of its box.
export const getBookingStatusLabel = booking => bookingState(booking).text
export const getBookingCardVariant = booking => bookingState(booking).variant

// Presentation only: use the existing occupied intervals and persisted buffers.
// Free intervals are context, not available slots or measured journey times.
export function dayTimeline(data, date, now) {
  const context = dayContext(data, date, now)
  const rows = []
  const add = (kind, id, start, end, extra = {}) => rows.push({ kind, id, start, end, ...extra })
  const bufferIntervals = []
  function buffers(row) {
    const buffer = Number(row.travel_buffer_minutes) || 0
    if (buffer <= 0) return
    const end = row.start_minutes + row.treatment_duration_minutes
    bufferIntervals.push([Math.max(0, row.start_minutes - buffer), row.start_minutes])
    bufferIntervals.push([end, Math.min(1440, end + buffer)])
  }
  for (const booking of data.bookings) {
    add('booking', booking.id, booking.start_minutes, booking.start_minutes + booking.treatment_duration_minutes, { booking })
    if (['confirmed', 'completed', 'awaiting_payment_verification', 'awaiting_cash_approval', 'awaiting_transfer'].includes(booking.booking_status)) buffers(booking)
  }
  for (const block of data.blocks) add('block', block.id, block.start_minutes, block.end_minutes, { title: block.title || (block.kind === 'personal_event' ? 'Personal event' : 'Blocked time'), block })
  for (const hold of context.holds) {
    add('hold', hold.id, hold.start_minutes, hold.start_minutes + hold.treatment_duration_minutes)
    buffers(hold)
  }
  // Normalize display intervals only; dayContext remains authoritative for free time.
  const mergedBuffers = []
  for (const [start, end] of bufferIntervals.sort((a, b) => a[0] - b[0])) {
    if (end <= start) continue
    const previous = mergedBuffers.at(-1)
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end)
    else mergedBuffers.push([start, end])
  }
  for (const [start, end] of mergedBuffers) add('buffer', `buffer-${start}-${end}`, start, end)
  if (context.hours?.available) {
    for (const [start, end] of context.gaps) {
      // Cancelled bookings stay visible without taking time out of free gaps.
      const cuts = [...new Set([start, end, ...data.bookings.flatMap(b => [b.start_minutes, b.start_minutes + b.treatment_duration_minutes]).filter(value => value > start && value < end)])].sort((a, b) => a - b)
      for (let i = 1; i < cuts.length; i++) add('free', `free-${cuts[i - 1]}`, cuts[i - 1], cuts[i])
    }
  }
  const order = { booking: 1, block: 2, hold: 3, buffer: 4, free: 5 }
  return { ...context, rows: rows.sort((a, b) => a.start - b.start || order[a.kind] - order[b.kind]) }
}
