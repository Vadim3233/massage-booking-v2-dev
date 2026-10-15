import { supabase } from '../../lib/supabase.js'

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
])
// What the database says that a client should read in other words: this is what someone sees when they are signed in as a different
// person (or as the Admin) and open a booking that is not on that account.
const REWRITES = new Map([
  ['Booking is not available to this client', 'This appointment is not on the account you are signed in to. If you booked as a guest, open the link in your latest confirmation email, or contact Vad.'],
])
const GENERIC = 'Something went wrong. Please try again, or contact Vad if it keeps happening.'

// Messages with a number in them, because the number comes from the Admin's settings.
const SAFE_PATTERNS = [/^Online appointments can currently be arranged up to \d+ days ahead\. Please choose (another|an earlier) date\.$/]

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
      reschedule: (id, requestId, date, start, fee) => by('reschedule_by_key', { p_request_id: requestId, p_new_date: date, p_new_start_minutes: start, p_acknowledged_fee: fee }),
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
    reschedule: (id, requestId, date, start, fee) => call('client_reschedule_booking', { p_booking_id: id, p_request_id: requestId, p_new_date: date, p_new_start_minutes: start, p_acknowledged_fee: fee }),
  }
}
export const accountApi = createAccountApi(supabase)
