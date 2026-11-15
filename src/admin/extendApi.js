import { supabase } from '../lib/supabase.js'
import { hasStarted, shiftDate, time, today } from './calendarPresentation.js'
import { whatsappNumber } from './contactLinks.js'

// Extra time: a client asks to stay longer (20261219100000_extend_session.sql). Only the Admin adds it, from the session's start until 7 days after.

export const STEPS = [15, 30, 45, 60]
export const MAX_EXTRA = 120
export const PAY_LABELS = {
  cash: 'Cash now, received',
  transfer: 'Ask for it by bank transfer',
  bill: 'Add it to what they pay',
  free: 'No charge',
}

export const extensionsOf = booking => booking?.booking_extensions || []
export const extraMinutes = booking => extensionsOf(booking).reduce((sum, item) => sum + Number(item.minutes || 0), 0)

// Whether the booking card and the booking offer "Add extra time": a session that went ahead, once it has started, for up to 7 days.
export function canExtend(booking, now = new Date()) {
  if (!booking || !['confirmed', 'completed'].includes(booking.booking_status)) return false
  const payment = Array.isArray(booking.booking_payments) ? booking.booking_payments[0] : booking.booking_payments
  if (!payment || ['rejected', 'refunded'].includes(payment.status)) return false
  if (extraMinutes(booking) >= MAX_EXTRA) return false
  return hasStarted(booking, now) && booking.date >= shiftDate(today(), -7)
}

// The suggested price: the hourly price pro rata, to the nearest £1 (£90 an hour: +15 £23, +30 £45, +45 £68, +60 £90).
export function suggestedPrice(hourPrice, minutes) {
  const hour = Number(hourPrice)
  if (!Number.isFinite(hour) || hour <= 0 || !minutes) return 0
  return Math.round(hour * minutes / 60)
}

// "30 min", "1 h", "1 h 15 min".
export function minutesWords(minutes) {
  const value = Number(minutes) || 0
  const hours = Math.floor(value / 60)
  const rest = value % 60
  if (!hours) return `${rest} min`
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

// What the next appointment that day means for this one made longer: whether it now runs into the next one or its travel time.
export function nextClash(preview, minutes) {
  const next = preview?.next
  if (!next) return null
  const ends = Number(preview.end_minutes) + Number(minutes || 0)
  const travel = Number(next.travel_buffer_minutes) || 0
  const leaveBy = Number(next.start_minutes) - travel
  return { ends, travel, leaveBy, late: Math.max(0, ends - leaveBy), clash: ends > leaveBy, next }
}

// A short "running late" message for the next client, for WhatsApp: rounded up to the next 5 minutes.
export function runningLateText(firstName, lateMinutes) {
  const late = Math.max(5, Math.ceil(Number(lateMinutes || 0) / 5) * 5)
  const name = String(firstName || '').trim()
  return `${name ? `Hi ${name}, ` : 'Hi, '}just to let you know I'm running about ${late} minutes late today. Sorry about that, see you soon!\n\nWarm wishes,\nVadim`
}
export function runningLateLink(next, lateMinutes) {
  const number = whatsappNumber(next?.phone)
  return number ? `https://wa.me/${number}?text=${encodeURIComponent(runningLateText(next.first_name, lateMinutes))}` : null
}

// One line of extra time on the booking: "+30 min · £45.00 · cash".
export const PAY_SHORT = { cash: 'paid in cash', transfer: 'by transfer', bill: 'on the bill', free: 'no charge' }

// The "+30 min" a card adds to the booking's length.
export const extraBadge = booking => {
  const minutes = extraMinutes(booking)
  return minutes ? `+${minutesWords(minutes)}` : ''
}

export function newEnd(preview, minutes) {
  return preview ? time(Number(preview.end_minutes) + Number(minutes || 0)) : ''
}

const SAFE = new Set([
  'Extra time can only be added to a session that went ahead.',
  'The session has not started yet. To make it longer before then, use Edit booking.',
  'Extra time can be added up to 7 days after the session.',
  'This booking has no payment to add extra time to.',
  'Choose who stayed longer.',
  'Choose 15 minutes to 2 hours of extra time.',
  'Enter a price between £0 and £1,000.',
  'That way of paying does not fit this booking. Please check it and try again.',
  'A booking can have up to 2 hours of extra time in all.',
  'That would run past midnight. Choose less extra time.',
  'Extra time can only be changed on a session that went ahead.',
  'The extra has already been received, so this extra time cannot be removed.',
  'The bill with this extra time has already been paid, so it cannot be removed.',
  'Enter an hourly price between £1 and £1,000',
])
function failure(error) {
  const conflict = ['PT409', '40001'].includes(error?.code) && !SAFE.has(error?.message)
  const result = new Error(SAFE.has(error?.message) ? error.message
    : conflict ? 'This booking changed before you could finish, so it has been reloaded. Please check it and try again.'
      : 'Could not save the extra time. Please try again.')
  result.conflict = conflict
  return result
}

export function createExtendApi(client) {
  async function call(name, args) {
    const { data, error } = await client.rpc(name, args)
    if (error) throw failure(error)
    return data
  }
  return {
    preview: id => call('admin_extend_preview', { p_booking_id: id }),
    extend: (booking, requestId, { sessionId, minutes, price, payBy, notify }) => call('admin_extend_booking', {
      p_booking_id: booking.id, p_request_id: requestId, p_booking_updated_at: booking.updated_at, p_session_id: sessionId,
      p_minutes: minutes, p_price_gbp: price, p_pay_by: payBy, p_notify: Boolean(notify) }),
    remove: (booking, extension, requestId) => call('admin_remove_extension', { p_extension_id: extension.id, p_request_id: requestId, p_booking_updated_at: booking.updated_at }),
    async rate() {
      const { data, error } = await client.from('business_settings').select('value').eq('key', 'extra_time_rate').maybeSingle()
      if (error) throw new Error('Could not load the extra time price. Please try again.')
      const value = Number(data?.value?.hourly_gbp)
      return Number.isFinite(value) && value > 0 ? value : null
    },
    saveRate: hourly => call('admin_save_extra_time_rate', { p_hourly_gbp: hourly }),
  }
}
export const extendApi = createExtendApi(supabase)

// How many of a client's bookings had extra time, from rows of booking_extensions with their booking's id.
export const stayedLongerCount = rows => new Set((rows || []).map(row => row.booking_id)).size
