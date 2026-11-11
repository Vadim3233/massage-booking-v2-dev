import { supabase } from '../lib/supabase.js'
import { sessionsPayload } from '../booking/bookingChange.js'

// Edit booking (Vadim's rules, 11 Nov 2026): who is coming, treatments, lengths, date and time in one step. The database works out the price
// and the money (admin_preview_booking_change) and saves it all at once (admin_edit_booking).
const CONFLICT = 'This booking changed before you could finish. Close it, open it again and try once more.'
// Sentences the database writes for the Admin; anything else is replaced with a generic line.
const SAFE = new Set([
  'A booking is for one to four people.',
  'Choose a treatment for each person.',
  'Choose 60, 90 or 120 minutes for each person.',
  'Keep each name under 120 characters.',
  'One visit can be up to 4 hours in all.',
  'Nothing has changed.',
  'Only an appointment still to happen can be changed.',
  'This time is not available. Choose another time.',
  'That time is in the past. Choose another time.',
  'That appointment would run past midnight. Choose an earlier time.',
  'That time overlaps another appointment, so it is not available. Choose another time.',
  'A client is in the middle of booking that day. Try again in a few minutes.',
  'Made longer, it would run into another appointment. Choose another time as well.',
  'Choose a date within the next 365 days and a 30-minute start',
])
const SAFE_PATTERNS = [/^That treatment is not offered for \d+ minutes\. Choose another length or treatment\.$/]

export function editFailure(error, generic = 'Could not save the change. Please check your connection and try again.') {
  const known = SAFE.has(error?.message) || SAFE_PATTERNS.some(pattern => pattern.test(error?.message || ''))
  if (known) return new Error(error.message)
  if (['PT409', '40001'].includes(error?.code)) return Object.assign(new Error(CONFLICT), { conflict: true })
  return new Error(generic)
}

export function createEditBookingApi(client) {
  return {
    // The treatments and their prices that can be chosen (shown ones only).
    async catalogue() {
      const [services, prices] = await Promise.all([
        client.from('services').select('id,name').eq('active', true).order('display_order'),
        client.from('service_duration_prices').select('service_id,duration_minutes,price_gbp').eq('active', true).order('duration_minutes'),
      ])
      if (services.error || prices.error) throw new Error("I couldn't load the treatments. Please try again.")
      return { services: services.data, prices: prices.data }
    },
    async preview(bookingId, people, lowerPrice) {
      const { data, error } = await client.rpc('admin_preview_booking_change', { p_booking_id: bookingId, p_sessions: sessionsPayload(people), p_lower_price: Boolean(lowerPrice) })
      if (error) throw editFailure(error, "I couldn't work out the new price. Please try again.")
      return data
    },
    async save(booking, requestId, change) {
      const { error } = await client.rpc('admin_edit_booking', {
        p_booking_id: booking.id, p_request_id: requestId, p_booking_updated_at: booking.updated_at, p_sessions: sessionsPayload(change.people),
        p_new_date: change.slot?.date ?? null, p_new_start_minutes: change.slot?.start ?? null, p_any_time: Boolean(change.slot?.anyTime),
        p_notify_client: change.notify !== false, p_lower_price: Boolean(change.lowerPrice),
      })
      if (error) throw editFailure(error)
    },
    // "Mark extra received": what was still to pay after the price went up has come in.
    async balanceReceived(booking, requestId) {
      const { error } = await client.rpc('admin_record_balance_received', { p_booking_id: booking.id, p_request_id: requestId, p_booking_updated_at: booking.updated_at })
      if (error) throw editFailure(error, 'Could not record it. Please check your connection and try again.')
    },
  }
}
export const editBookingApi = createEditBookingApi(supabase)
