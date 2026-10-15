import { supabase } from '../lib/supabase.js'

// Messages written for the Admin on the server. Anything else becomes a generic line.
export const SAFE_MESSAGES = new Set([
  'Another client already uses this email or phone.',
  'An existing client uses this email or phone. Select that client instead.',
  'Name and a valid email or phone are required',
  'Address, city and postcode are required',
  'Two clients who each have their own login cannot be combined.',
  'The client with the login is the one that stays.',
  'One of these clients is no longer there. They may already have been combined.',
  // Deleting a client
  'That client is no longer there. They may already have been deleted or combined.',
  'This client has bookings, so they cannot be deleted. Bookings, payments and receipts are your records.',
  'This client has a repeating booking, so they cannot be deleted.',
  'Someone is in the middle of booking right now. Try again in a few minutes.',
  'This client is signed in as an Admin, so they cannot be deleted here.',
  'Something changed while you were deciding. Please look at the question again.',
])
const GENERIC = 'Could not complete that. Please check your connection and try again.'
const failure = error => new Error(SAFE_MESSAGES.has(error?.message) ? error.message : GENERIC)

export const fullName = client => [client?.first_name, client?.last_name].filter(Boolean).join(' ') || 'Client'

export function validateClient(details) {
  if (!details.first_name?.trim()) return 'Enter a first name.'
  const phone = (details.phone || '').replace(/[^0-9]/g, '')
  const email = (details.email || '').trim()
  if (!email && !phone) return 'Enter a phone number or an email address.'
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'That email address does not look right.'
  if (phone && (phone.length < 7 || phone.length > 20)) return 'That phone number does not look right.'
  return ''
}
export function validateAddress(address) {
  if (!address.address_line_1?.trim() || !address.city?.trim() || !address.postcode?.trim()) return 'Enter the street, city and postcode.'
  return ''
}

export function createClientsApi(client) {
  async function run(request) {
    const { data, error } = await request
    if (error) throw failure(error)
    return data
  }
  const one = async request => { const rows = await run(request); return Array.isArray(rows) ? rows[0] : rows }
  const addressRow = address => ({
    label: address.label?.trim() || null, address_line_1: address.address_line_1.trim(), address_line_2: address.address_line_2?.trim() || null,
    city: address.city.trim(), postcode: address.postcode.trim(), entry_instructions: address.entry_instructions?.trim() || null,
  })
  return {
    search: query => run(client.rpc('admin_search_clients', { p_query: query || '' })),
    get: id => run(client.from('clients').select('id,first_name,last_name,email,phone,auth_user_id,online_booking_enabled,created_at').eq('id', id).maybeSingle()),
    summary: id => run(client.rpc('admin_client_summary', { p_client_id: id })),
    create: (details, requestId) => one(client.rpc('admin_create_client', { p_details: details, p_request_id: requestId })),
    update: (id, details) => one(client.rpc('admin_update_client', { p_client_id: id, p_details: details })),
    setOnlineBooking: (id, enabled) => run(client.from('clients').update({ online_booking_enabled: enabled }).eq('id', id)),
    addresses: id => run(client.from('client_addresses').select('id,label,address_line_1,address_line_2,city,postcode,entry_instructions,is_default').eq('client_id', id).order('is_default', { ascending: false }).order('created_at')),
    addAddress: (id, address) => run(client.from('client_addresses').insert({ client_id: id, ...addressRow(address) })),
    updateAddress: (id, address) => run(client.from('client_addresses').update(addressRow(address)).eq('id', id)),
    deleteAddress: id => run(client.from('client_addresses').delete().eq('id', id)),
    setDefaultAddress: (clientId, addressId) => run(client.rpc('admin_set_default_address', { p_client_id: clientId, p_address_id: addressId })),
    // Two profiles that might be one person: the pairs the app has noticed, a side-by-side look at two, and the Admin's answer.
    possibleDuplicates: () => run(client.rpc('admin_possible_duplicates')),
    combinePreview: (a, b) => run(client.rpc('admin_combine_preview', { p_client_a: a, p_client_b: b })),
    keepSeparate: (a, b) => run(client.rpc('admin_keep_clients_separate', { p_client_a: a, p_client_b: b })),
    combine: (keepId, removeId, requestId) => run(client.rpc('admin_merge_clients', { p_keep_client_id: keepId, p_remove_client_id: removeId, p_request_id: requestId })),
    // Deleting a client who has no bookings: what the database says about it first, then the deletion itself, which carries what the
    // question said would go (see deleteScope) and is refused if anything about that changed in between.
    deleteCheck: id => run(client.rpc('admin_client_delete_check', { p_client_id: id })),
    deleteClient: (id, requestId, expected) => run(client.rpc('admin_delete_client', { p_client_id: id, p_request_id: requestId, p_expected: expected })),
    notes: id => run(client.from('client_notes').select('id,note,created_at').eq('client_id', id).order('created_at', { ascending: false }).limit(100)),
    async addNote(id, note) {
      const { data: user } = await client.auth.getUser()
      return run(client.from('client_notes').insert({ client_id: id, note: note.trim(), author_user_id: user?.user?.id || null }))
    },
    deleteNote: id => run(client.from('client_notes').delete().eq('id', id)),
    bookings: (id, from, to) => run(client.from('bookings').select('id,booking_reference,date,start_minutes,treatment_duration_minutes,total_gbp,booking_status,late_fee_status,late_fee_due_gbp,refund_due_gbp,booking_payments(method,status),booking_sessions(service_name_snapshot,position)')
      .eq('client_id', id).order('date', { ascending: false }).order('start_minutes', { ascending: false }).range(from, to)),
  }
}
export const clientsApi = createClientsApi(supabase)
