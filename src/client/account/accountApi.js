import { supabase } from '../../lib/supabase.js'

// Messages written for clients on the server. Anything else becomes a generic, non-technical line.
const SAFE_MESSAGES = new Set([
  'The late fee has changed. Please review it and confirm again.',
  'This booking can no longer be changed online. Please contact Vad.',
  'This appointment has already started. Please contact Vad.',
  'This time is not available. Please choose another time.',
  'Please choose a start time on the hour or half hour.',
  'Online appointments can currently be arranged up to 40 days ahead. Please choose another date.',
  'Please keep the reason under 500 characters',
])
const GENERIC = 'Something went wrong. Please try again, or contact Vad if it keeps happening.'

export function friendlyError(error) {
  const failure = new Error(SAFE_MESSAGES.has(error?.message) ? error.message : GENERIC)
  failure.refresh = error?.code === 'PT409'
  return failure
}

export function createAccountApi(client) {
  async function call(name, args) {
    const { data, error } = await client.rpc(name, args)
    if (error) throw friendlyError(error)
    return data
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
