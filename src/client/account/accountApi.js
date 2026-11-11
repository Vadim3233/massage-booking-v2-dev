import { supabase } from '../../lib/supabase.js'
import { sessionsPayload } from '../../booking/bookingChange.js'

// What a client who opens a booking from the private link in an email is told when the link does not work. It says the same thing
// whether the code is wrong, old, or for another booking, so it gives nothing away.
export const LINK_INVALID = 'This link is not valid or has expired. Please contact Vad.'

// Messages written for clients on the server. Anything else becomes a generic, non-technical line.
const SAFE_MESSAGES = new Set([
  'The late fee has changed. Please review it and confirm again.',
  'This booking can no longer be changed online. Please contact Vad.',
  'This appointment has already started. Please contact Vad.',
  'This time is not available. Please choose another time.',
  'Please choose a start time on the hour or half hour.',
  'Please keep the reason under 500 characters',
  LINK_INVALID,
  // Changing who is coming, treatments or lengths (20261204100000_edit_booking_services.sql).
  'A booking is for one to four people.',
  'Choose a treatment for each person.',
  'Choose 60, 90 or 120 minutes for each person.',
  'Keep each name under 120 characters.',
  'One visit can be up to 4 hours in all.',
  'Nothing has changed.',
  'The price has changed. Please check it and confirm again.',
])
// What the database says that a client should read in other words: this is what someone sees when they are signed in as a different
// person (or as the Admin) and open a booking that is not on that account.
const REWRITES = new Map([
  ['Booking is not available to this client', 'This appointment is not on the account you are signed in to. If you booked as a guest, open the link in your latest confirmation email, or contact Vad.'],
])
const GENERIC = 'Something went wrong. Please try again, or contact Vadim if it keeps happening.'

// Messages with a number in them, because the number comes from the Admin's settings.
const SAFE_PATTERNS = [
  /^Online appointments can currently be arranged up to \d+ days ahead\. Please choose (another|an earlier) date\.$/,
  /^That treatment is not offered for \d+ minutes\. Choose another length or treatment\.$/,
  /^In .{1,120} the minimum booking is .{1,40} in total\. Please contact Vadim to make it shorter\.$/,
]

export function friendlyError(error) {
  const known = SAFE_MESSAGES.has(error?.message) || SAFE_PATTERNS.some(pattern => pattern.test(error?.message || ''))
  const failure = new Error(REWRITES.get(error?.message) || (known ? error.message : GENERIC))
  failure.refresh = error?.code === 'PT409'
  return failure
}

// `link` is { bookingId, key } for someone who opened the private link in an email: the same five things, for that one booking, with
// no sign-in. Without it, the calls are the signed-in client's own.
export function createAccountApi(client, link = null) {
  async function call(name, args) {
    const { data, error } = await client.rpc(name, args)
    if (error) throw friendlyError(error)
    return data
  }
  if (link) {
    const by = (name, args = {}) => call(name, { p_booking_id: link.bookingId, p_key: link.key, ...args })
    return {
      // A link opens one booking; the list of all of someone's bookings needs them to sign in.
      list: async () => [],
      booking: () => by('booking_by_key'),
      terms: () => by('change_terms_by_key'),
      async availability(id, date) {
        const rows = await by('availability_by_key', { p_date: date })
        return rows.map(row => row.start_minutes)
      },
      cancel: (id, requestId, fee, reason) => by('cancel_by_key', { p_request_id: requestId, p_acknowledged_fee: fee, p_reason: reason || null }),
      receipt: () => by('receipt_by_key'),
      reschedule: (id, requestId, date, start, fee) => by('reschedule_by_key', { p_request_id: requestId, p_new_date: date, p_new_start_minutes: start, p_acknowledged_fee: fee }),
      changePreview: (id, people) => by('change_preview_by_key', { p_sessions: sessionsPayload(people) }),
      async changeTimes(id, date, minutes) {
        const rows = await by('change_times_by_key', { p_date: date, p_minutes: minutes })
        return rows.map(row => row.start_minutes)
      },
      change: (id, requestId, people, date, start, total) => by('change_by_key', { p_request_id: requestId, p_sessions: sessionsPayload(people), p_new_date: date, p_new_start_minutes: start, p_acknowledged_total: total }),
    }
  }
  return {
    list: () => call('list_my_bookings'),
    booking: id => call('get_my_booking', { p_booking_id: id }),
    terms: id => call('get_my_change_terms', { p_booking_id: id }),
    async availability(id, date) {
      const rows = await call('get_my_booking_availability', { p_booking_id: id, p_date: date })
      return rows.map(row => row.start_minutes)
    },
    cancel: (id, requestId, fee, reason) => call('client_cancel_booking', { p_booking_id: id, p_request_id: requestId, p_acknowledged_fee: fee, p_reason: reason || null }),
    // The receipt for a paid booking, to download as a PDF, or nothing when the booking has none.
    receipt: id => call('get_my_receipt', { p_booking_id: id }),
    reschedule: (id, requestId, date, start, fee) => call('client_reschedule_booking', { p_booking_id: id, p_request_id: requestId, p_new_date: date, p_new_start_minutes: start, p_acknowledged_fee: fee }),
    // Changing who is coming, treatments or lengths (and the time with them). `total` is the price the client was shown.
    changePreview: (id, people) => call('my_booking_change_preview', { p_booking_id: id, p_sessions: sessionsPayload(people) }),
    async changeTimes(id, date, minutes) {
      const rows = await call('my_booking_change_times', { p_booking_id: id, p_date: date, p_minutes: minutes })
      return rows.map(row => row.start_minutes)
    },
    change: (id, requestId, people, date, start, total) => call('change_my_booking', { p_booking_id: id, p_request_id: requestId, p_sessions: sessionsPayload(people), p_new_date: date, p_new_start_minutes: start, p_acknowledged_total: total }),
  }
}
export const accountApi = createAccountApi(supabase)
