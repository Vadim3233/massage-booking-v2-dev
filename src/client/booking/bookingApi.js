// Explicit client contracts: no client IDs, prices, payment state or order writes.
export async function unwrap(request) {
  const { data, error } = await request
  if (error) throw error
  return data
}

async function one(request) {
  const rows = await unwrap(request)
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('The server did not return a result. Please retry.')
  return rows[0]
}

export function quoteParams(draft) {
  return {
    p_service_area_id: draft.areaId,
    p_sessions: draft.sessions.map(({ duration_minutes, recipient_name, preference_ids }) => ({
      service_id: draft.serviceId, duration_minutes, recipient_name, preference_ids,
    })),
    p_enhancement_ids: [...draft.enhancementIds],
  }
}

export function finalizeParams(draft, clientKey, idempotencyKey) {
  return {
    ...quoteParams(draft),
    p_hold_id: draft.hold.hold_id,
    p_hold_token: draft.hold.hold_token,
    p_hold_client_key: clientKey,
    p_saved_address_id: draft.details.savedAddressId || null,
    p_address_line_1: draft.details.address_line_1.trim(),
    p_address_line_2: draft.details.address_line_2.trim() || null,
    p_city: draft.details.city.trim(),
    p_postcode: draft.details.postcode.trim(),
    p_entry_instructions: draft.details.entry_instructions.trim() || null,
    p_client_note: draft.note.trim() || null,
    // Payment always starts as a provisional bank-transfer reservation.
    // Cash is selected afterwards through confirm_my_cash_booking.
    p_payment_method: 'bank_transfer',
    p_idempotency_key: idempotencyKey,
  }
}

export function createBookingApi(client) {
  return {
    async catalogue() {
      const definitions = [
        ['areas', 'service_areas', 'id,name,travel_surcharge_gbp,congestion_fee_gbp', 'display_order'],
        ['services', 'services', 'id,name,short_description,long_description', 'display_order'],
        ['prices', 'service_duration_prices', 'service_id,duration_minutes,price_gbp', 'duration_minutes'],
        ['enhancements', 'enhancements', 'id,name,description,price_gbp', 'display_order'],
        ['preferences', 'session_preferences', 'id,label,category', 'display_order'],
      ]
      const entries = await Promise.all(definitions.map(async ([key, table, columns, sort]) =>
        [key, await unwrap(client.from(table).select(columns).eq('active', true).order(sort))]))
      entries.push(['conflicts', await unwrap(client.from('session_preference_conflicts').select('preference_id,conflicting_preference_id'))])
      return Object.fromEntries(entries)
    },
    availability: (date, duration, hold = null, key = null) => unwrap(client.rpc('get_booking_availability', {
      p_date: date, p_treatment_duration_minutes: duration,
      ...(hold ? { p_hold_id: hold.hold_id, p_hold_token: hold.hold_token, p_client_key: key } : {}),
    })),
    hold: (date, start, duration, key) => one(client.rpc('create_booking_hold', {
      p_date: date, p_start_minutes: start, p_treatment_duration_minutes: duration, p_client_key: key,
    })),
    release: (hold, key) => one(client.rpc('release_booking_hold', {
      p_hold_id: hold.hold_id, p_hold_token: hold.hold_token, p_client_key: key,
    })),
    extend: (hold, key) => one(client.rpc('extend_booking_hold', {
      p_hold_id: hold.hold_id, p_hold_token: hold.hold_token, p_client_key: key,
    })),
    quote: (draft) => one(client.rpc('quote_client_booking', quoteParams(draft))),
    activate: (details = {}) => one(client.rpc('activate_my_client_account', {
      p_first_name: details.first_name?.trim() || null,
      p_last_name: details.last_name?.trim() || null,
      p_phone: details.phone?.trim() || null,
    })),
    activateGuest: (details = {}) => one(client.rpc('activate_guest_client_account', {
      p_first_name: details.first_name?.trim() || null,
      p_last_name: details.last_name?.trim() || null,
      p_email: details.email?.trim() || null,
      p_phone: details.phone?.trim() || null,
    })),
    addresses: () => unwrap(client.from('client_addresses')
      .select('id,label,address_line_1,address_line_2,city,postcode,entry_instructions,is_default')
      .order('is_default', { ascending: false })),
    finalize: (params) => one(client.rpc('finalize_client_booking', params)),
    booking: (id) => unwrap(client.rpc('get_my_booking', { p_booking_id: id })),
    declareTransfer: (id) => unwrap(client.rpc('declare_my_bank_transfer', { p_booking_id: id })),
    confirmCash: (id) => unwrap(client.rpc('confirm_my_cash_booking', { p_booking_id: id })),
  }
}
