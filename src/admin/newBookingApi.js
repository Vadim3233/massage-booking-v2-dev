import { supabase } from '../lib/supabase.js'
import { createBookingApi, quoteParams, unwrap } from '../client/booking/bookingApi.js'
import { withGuestNames } from '../booking/guestNames.js'
import { clientLabel } from './newBooking/presentation.js'

async function one(request) {
  const result = await unwrap(request)
  if (!Array.isArray(result) || result.length !== 1) throw new Error('No result returned. Retry the same request.')
  return result[0]
}

export function bookingRequest(draft) {
  return {
    client_id: draft.client.id,
    saved_address_id: draft.details.savedAddressId || null,
    // A one-off address goes as one text, with the way in if there is one.
    address: draft.details.savedAddressId ? null : { address: draft.details.address?.trim() || null, entry_instructions: draft.details.entry_instructions?.trim() || null },
    service_area_id: draft.areaId,
    sessions: withGuestNames(quoteParams(draft).p_sessions, clientLabel(draft.client)),
    enhancement_ids: [...draft.enhancementIds],
    date: draft.date,
    start_minutes: draft.start,
    payment_arrangement: draft.payment,
    note: draft.note.trim() || null,
    // A time chosen from "Show all times" that is not one of the usual ones: the database then sets the usual rules aside, but never allows a double booking.
    // (Not for something that has already happened: that sets them aside in its own way, and the database refuses the two together.)
    ...(draft.anyTime && !draft.past ? { any_time: true } : {}),
    // An appointment that has already happened, recorded on purpose: the database then records it as completed if it is paid, and tells no one.
    ...(draft.past ? { past: true } : {}),
  }
}

export function createAdminNewBookingApi(client) {
  return {
    catalogue: createBookingApi(client).catalogue,
    search: query => unwrap(client.rpc('admin_search_clients', { p_query: query })),
    client: id => unwrap(client.from('clients').select('id,first_name,last_name,email,phone').eq('id', id).maybeSingle()),
    addresses: clientId => unwrap(client.rpc('admin_client_addresses', { p_client_id: clientId })),
    // The client's most recent booking that was not cancelled, used only to suggest defaults. A client whose bookings were all cancelled is still
    // suggested the area of the last of them (only the area: what was cancelled says nothing sure about the treatment or the payment).
    lastBooking: async clientId => {
      const newest = async (columns, cancelled) => {
        const rows = client.from('bookings').select(columns).eq('client_id', clientId)
        return (await unwrap((cancelled ? rows.eq('booking_status', 'cancelled') : rows.neq('booking_status', 'cancelled')).order('date', { ascending: false }).order('start_minutes', { ascending: false }).limit(1)))?.[0] || null
      }
      return await newest('service_area_id,booking_sessions(service_id,duration_minutes,position),booking_payments(method)', false) || newest('service_area_id', true)
    },
    createClient: (details, requestId) => one(client.rpc('admin_create_client', { p_details: details, p_request_id: requestId })),
    quote: draft => one(client.rpc('admin_quote_booking', quoteParams(draft))),
    availability: (date, duration) => unwrap(client.rpc('admin_booking_availability', { p_date: date, p_treatment_duration_minutes: duration })),
    // Every half hour of the day, what is booked, her working hours, and which times are usual or overlap another appointment.
    times: (date, duration) => unwrap(client.rpc('admin_booking_times', { p_date: date, p_treatment_duration_minutes: duration })),
    // The same for a day that has gone: every half hour that has begun, and what was in the diary.
    pastTimes: (date, duration) => unwrap(client.rpc('admin_past_booking_times', { p_date: date, p_treatment_duration_minutes: duration })),
    create: (request, requestId) => one(client.rpc('admin_create_booking', { p_request: request, p_request_id: requestId })),
    // How often it repeats is sent only when it is not simply every week, which is what it always was.
    createSeries: (request, endDate, requestId, pattern) => one(client.rpc('admin_create_series', { p_request: request, p_end_date: endDate || null, p_request_id: requestId, ...(pattern ? { p_pattern: pattern } : {}) })),
  }
}

export const adminNewBookingApi = createAdminNewBookingApi(supabase)
