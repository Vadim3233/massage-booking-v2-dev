import { supabase } from '../lib/supabase.js'
import { createBookingApi, quoteParams, unwrap } from '../client/booking/bookingApi.js'

async function one(request) {
  const result = await unwrap(request)
  if (!Array.isArray(result) || result.length !== 1) throw new Error('No result returned. Retry the same request.')
  return result[0]
}

export function bookingRequest(draft) {
  return {
    client_id: draft.client.id,
    saved_address_id: draft.details.savedAddressId || null,
    address: draft.details.savedAddressId ? null : Object.fromEntries(['address_line_1', 'address_line_2', 'city', 'postcode', 'entry_instructions'].map(key => [key, draft.details[key]?.trim() || null])),
    service_area_id: draft.areaId,
    sessions: quoteParams(draft).p_sessions,
    enhancement_ids: [...draft.enhancementIds],
    date: draft.date,
    start_minutes: draft.start,
    payment_arrangement: draft.payment,
    note: draft.note.trim() || null,
  }
}

export function createAdminNewBookingApi(client) {
  return {
    catalogue: createBookingApi(client).catalogue,
    search: query => unwrap(client.rpc('admin_search_clients', { p_query: query })),
    client: id => unwrap(client.from('clients').select('id,first_name,last_name,email,phone').eq('id', id).maybeSingle()),
    addresses: clientId => unwrap(client.rpc('admin_client_addresses', { p_client_id: clientId })),
    createClient: (details, requestId) => one(client.rpc('admin_create_client', { p_details: details, p_request_id: requestId })),
    quote: draft => one(client.rpc('admin_quote_booking', quoteParams(draft))),
    availability: (date, duration) => unwrap(client.rpc('admin_booking_availability', { p_date: date, p_treatment_duration_minutes: duration })),
    create: (request, requestId) => one(client.rpc('admin_create_booking', { p_request: request, p_request_id: requestId })),
  }
}

export const adminNewBookingApi = createAdminNewBookingApi(supabase)
