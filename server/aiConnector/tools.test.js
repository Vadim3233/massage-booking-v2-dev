import { describe, expect, it, vi } from 'vitest'
import { bookingSummary, createTools, googleCalendarLink, londonToday, parseTime } from './tools.js'

const area = { id: 'area-1', name: 'Chelsea', travel_surcharge_gbp: 10, congestion_fee_gbp: 0, postcodes: ['SW3'] }
const other = { id: 'area-2', name: 'Hayes', travel_surcharge_gbp: 0, congestion_fee_gbp: 0, postcodes: ['UB3'] }
const service = { id: 'svc-1', name: 'Deep tissue', short_description: 'Firm' }
const address = { id: 'addr-1', label: 'Home', address: '1 King\'s Road, London, SW3 4LP', entry_instructions: '', is_default: true }
const quote = { service_subtotal_gbp: 170, enhancements_total_gbp: 0, travel_fee_gbp: 10, congestion_fee_gbp: 0, total_gbp: 180, treatment_duration_minutes: 120 }

// A stand-in for a Supabase client signed in as one client: tables for the catalogue, and the client functions the tools call.
function fakeClient(overrides = {}) {
  const tables = {
    service_areas: [area, other], services: [service], service_duration_prices: [{ service_id: 'svc-1', duration_minutes: 60, price_gbp: 85 }, { service_id: 'svc-1', duration_minutes: 90, price_gbp: 115 }],
    enhancements: [], session_preferences: [], session_preference_conflicts: [], client_addresses: [address],
  }
  const query = rows => { const chain = { select: () => chain, eq: () => chain, order: () => chain, then: (resolve, reject) => Promise.resolve({ data: rows, error: null }).then(resolve, reject) }; return chain }
  const calls = []
  const answers = {
    note_ai_request: null,
    activate_my_client_account: [{ client_id: 'c1', first_name: 'Ana', last_name: 'Silva', online_booking_enabled: true }],
    get_booking_rules: { booking_horizon_days: 40, minimum_notice_hours: 2, free_cancellation_hours: 24 },
    list_my_bookings: [],
    get_booking_availability: [{ start_minutes: 600 }, { start_minutes: 1080 }],
    quote_client_booking: [quote],
    create_booking_hold: [{ hold_id: 'h1', hold_token: 't1', expires_at: '2026-11-04T10:20:00Z' }],
    finalize_client_booking: [{ booking_id: 'b1', booking_reference: 'VAD-1234', booking_status: 'awaiting_transfer', payment_status: 'awaiting_transfer', total_gbp: 180, payment_reference: 'VAD-1234' }],
    get_bank_details: { account_name: 'Vad Massage', sort_code: '00-00-00', account_number: '12345678' },
    get_my_booking: { id: 'b1', booking_reference: 'VAD-1234', date: '2026-11-04', start_minutes: 1080, treatment_duration_minutes: 120, address_snapshot: address.address, booking_sessions: [] },
    confirm_my_cash_booking: { booking_status: 'awaiting_cash_approval', booking_payments: { status: 'awaiting_cash_approval' } },
    declare_my_bank_transfer: { booking_status: 'awaiting_payment_verification', booking_payments: { status: 'awaiting_verification' } },
    my_telegram_status: { linked: false },
    create_my_telegram_link: 'abcdefghijklmnopqrstuvwxyz123456',
    ...overrides,
  }
  return {
    calls,
    from: table => query(tables[table] || []),
    rpc: vi.fn(async (name, args) => {
      calls.push([name, args])
      const value = typeof answers[name] === 'function' ? answers[name](args) : answers[name]
      if (value instanceof Error) return { data: null, error: value }
      return { data: value, error: null }
    }),
  }
}
const tools = (client, extra = {}) => createTools({ client, userId: 'user-1', origin: 'https://book.example.com', env: { TELEGRAM_CLIENT_BOT_USERNAME: 'VadMassageBot' }, now: () => new Date('2026-11-01T09:00:00Z'), ...extra })
const booking = { treatment_id: 'svc-1', lengths: [90, 90], address_id: 'addr-1', date: '2026-11-04', time: '18:00', payment_method: 'bank_transfer', expected_total_gbp: 180, client_confirmed: true }

describe('the booking tools', () => {
  it('lists eight tools, none of which cancels or moves anything', () => {
    const names = tools(fakeClient()).list().map(tool => tool.name)
    expect(names).toEqual(['get_my_booking_options', 'find_free_times', 'get_price', 'book_appointment', 'i_have_paid', 'list_my_bookings', 'add_to_calendar', 'connect_telegram'])
    expect(tools(fakeClient()).list().every(tool => tool.inputSchema?.type === 'object' && !('run' in tool))).toBe(true)
  })
  it('counts every call against the hourly limit, and stops when the database says so', async () => {
    const client = fakeClient({ note_ai_request: Object.assign(new Error('Your assistant has asked too many times in the last hour. Please try again later, or book in the app.'), { code: '22023' }) })
    expect(await tools(client).call('list_my_bookings')).toEqual({ isError: true, text: 'Your assistant has asked too many times in the last hour. Please try again later, or book in the app.' })
    expect(client.calls.map(([name]) => name)).toEqual(['note_ai_request'])
  })
  it('gives the options with each address\'s area from its postcode', async () => {
    const { data } = await tools(fakeClient()).call('get_my_booking_options')
    expect(data.saved_addresses).toEqual([{ address_id: 'addr-1', label: 'Home', address: address.address, is_default: true, area_id: 'area-1', area: 'Chelsea' }])
    expect(data.treatments[0]).toMatchObject({ treatment_id: 'svc-1', lengths: [{ minutes: 60, price: '£85' }, { minutes: 90, price: '£115' }] })
    expect(data.max_people).toBe(2)
    expect(data.rules.cancellation).toMatch(/more than 24 hours/)
  })
  it('finds times for two people as one visit of both lengths together, and never more than seven days', async () => {
    const client = fakeClient()
    const { data } = await tools(client).call('find_free_times', { lengths: [60, 90], from_date: '2026-11-02', to_date: '2026-11-30' })
    const asked = client.calls.filter(([name]) => name === 'get_booking_availability')
    expect(asked).toHaveLength(7)
    expect(asked.every(([, args]) => args.p_treatment_duration_minutes === 150)).toBe(true)
    expect(data.days[0]).toEqual({ date: '2026-11-02', day: 'Monday, 2 November 2026', times: ['10:00', '18:00'] })
  })
  it('refuses three people, and a length that is not offered', async () => {
    expect((await tools(fakeClient()).call('find_free_times', { lengths: [60, 60, 60], from_date: '2026-11-02' })).text).toMatch(/one or 2 people/)
    expect((await tools(fakeClient()).call('get_price', { treatment_id: 'svc-1', lengths: [45], address_id: 'addr-1' })).text).toBe('Deep tissue is not offered for 45 minutes. Lengths: 60, 90 minutes.')
  })
  it('refuses an area that does not match the postcode, and an address that is not saved', async () => {
    expect((await tools(fakeClient()).call('get_price', { treatment_id: 'svc-1', lengths: [60], address_id: 'addr-1', area_id: 'area-2' })).text).toMatch(/SW3 4LP is in Chelsea, not Hayes/)
    expect((await tools(fakeClient()).call('get_price', { treatment_id: 'svc-1', lengths: [60], address_id: 'elsewhere' })).text).toMatch(/not saved on this account/)
  })
  it('will not book without the client\'s yes, or at a total they did not agree to', async () => {
    const client = fakeClient()
    expect((await tools(client).call('book_appointment', { ...booking, client_confirmed: false })).text).toMatch(/ask for a clear yes/)
    expect((await tools(client).call('book_appointment', { ...booking, expected_total_gbp: 150 })).text).toBe('The total is now £180, not £150. Tell the client the new total and ask again.')
    expect(client.calls.some(([name]) => name === 'finalize_client_booking')).toBe(false)
  })
  it('books a couple at a saved address, with payment details, the calendar and Telegram', async () => {
    const client = fakeClient()
    const { isError, data } = await tools(client).call('book_appointment', { ...booking, second_person_name: 'Sam' })
    expect(isError).toBe(false)
    const hold = client.calls.find(([name]) => name === 'create_booking_hold')[1]
    expect(hold).toEqual({ p_date: '2026-11-04', p_start_minutes: 1080, p_treatment_duration_minutes: 180, p_client_key: 'ai-assistant:user-1' })
    const final = client.calls.find(([name]) => name === 'finalize_client_booking')[1]
    expect(final).toMatchObject({ p_service_area_id: 'area-1', p_saved_address_id: 'addr-1', p_address: null, p_client_note: null, p_enhancement_ids: [], p_payment_method: 'bank_transfer' })
    expect(final.p_sessions).toEqual([
      { service_id: 'svc-1', duration_minutes: 90, recipient_name: 'Guest 1', preference_ids: [] },
      { service_id: 'svc-1', duration_minutes: 90, recipient_name: 'Sam', preference_ids: [] },
    ])
    expect(final.p_idempotency_key).toMatch(/^ai-[0-9a-f]{48}$/)
    expect(data.booking).toMatchObject({ reference: 'VAD-1234', start: '18:00', end: '21:00', total: '£180' })
    expect(data.payment).toMatchObject({ method: 'bank_transfer', amount: '£180', reference: 'VAD-1234', bank_details: { sort_code: '00-00-00' } })
    expect(data.add_to_calendar.google_calendar_link).toContain('dates=20261104T180000%2F20261104T200000')
    expect(data.add_to_calendar.ics_file).toContain('BEGIN:VCALENDAR')
    expect(data.telegram.link).toBe('https://t.me/VadMassageBot?start=abcdefghijklmnopqrstuvwxyz123456')
  })
  it('asks Vad to confirm a cash booking rather than saying it is booked', async () => {
    const client = fakeClient()
    const { data } = await tools(client).call('book_appointment', { ...booking, payment_method: 'cash' })
    expect(client.calls.some(([name]) => name === 'confirm_my_cash_booking')).toBe(true)
    expect(data.booking.status).toBe('Requested with cash, Vadim will confirm shortly')
    expect(data.payment.note).toMatch(/Vadim will confirm shortly/)
  })
  it('does not book twice when the assistant asks again', async () => {
    const client = fakeClient({ list_my_bookings: [{ id: 'b1', booking_reference: 'VAD-1234', booking_status: 'awaiting_transfer', payment_status: 'awaiting_transfer', date: '2026-11-04', start_minutes: 1080, treatment_duration_minutes: 180, total_gbp: 180 }] })
    const { data } = await tools(client).call('book_appointment', booking)
    expect(data.already_booked).toBe(true)
    expect(client.calls.some(([name]) => ['create_booking_hold', 'finalize_client_booking'].includes(name))).toBe(false)
  })
  it('passes on what the database says to a client, and hides anything technical', async () => {
    const taken = fakeClient({ create_booking_hold: Object.assign(new Error('This time is not available. Please choose another time.'), { code: '22023' }) })
    expect((await tools(taken).call('book_appointment', booking)).text).toBe('This time is not available. Please choose another time.')
    const broken = fakeClient({ create_booking_hold: Object.assign(new Error('relation "x" does not exist'), { code: '42P01' }) })
    expect((await tools(broken).call('book_appointment', booking)).text).toBe('Something went wrong on the booking side. Please try again, or book in the app.')
  })
  it('says so when online booking is switched off for the client', async () => {
    const client = fakeClient({ activate_my_client_account: [{ client_id: 'c1', online_booking_enabled: false }] })
    expect((await tools(client).call('find_free_times', { lengths: [60], from_date: '2026-11-02' })).text).toMatch(/isn't available on this account/)
  })
  it('tells Vad a transfer is sent, once', async () => {
    const waiting = fakeClient({ list_my_bookings: [{ id: 'b1', booking_reference: 'VAD-1234', booking_status: 'awaiting_transfer', payment_status: 'awaiting_transfer', date: '2026-11-04', start_minutes: 1080, treatment_duration_minutes: 60, total_gbp: 85 }] })
    expect((await tools(waiting).call('i_have_paid', { booking_reference: 'vad-1234' })).data.booking.payment).toBe('Transfer sent, Vadim is checking it')
    const paid = fakeClient({ list_my_bookings: [{ id: 'b1', booking_reference: 'VAD-1234', booking_status: 'confirmed', payment_status: 'paid', date: '2026-11-04', start_minutes: 1080, treatment_duration_minutes: 60, total_gbp: 85 }] })
    expect((await tools(paid).call('i_have_paid', { booking_reference: 'VAD-1234' })).data.note).toMatch(/Nothing to do/)
    expect(paid.calls.some(([name]) => name === 'declare_my_bank_transfer')).toBe(false)
  })
})

describe('small pieces', () => {
  it('reads times and London dates', () => {
    expect(parseTime('9:30')).toBe(570)
    expect(() => parseTime('25:00')).toThrow(/HH:MM/)
    expect(londonToday(new Date('2026-06-30T23:30:00Z'))).toBe('2026-07-01')
  })
  it('makes a Google Calendar link in London time, past midnight too', () => {
    const link = googleCalendarLink({ date: '2026-11-04', start_minutes: 1380, treatment_duration_minutes: 90, booking_reference: 'VAD-1' }, '1 Road, SW3 4LP')
    expect(link).toContain('dates=20261104T230000%2F20261105T003000')
    expect(link).toContain('ctz=Europe%2FLondon')
  })
  it('summarises a booking in words', () => {
    expect(bookingSummary({ booking_reference: 'VAD-1', date: '2026-11-04', start_minutes: 600, treatment_duration_minutes: 60, total_gbp: 85.5, booking_status: 'confirmed', payment_status: 'paid' }))
      .toEqual({ reference: 'VAD-1', date: '2026-11-04', day: 'Wednesday, 4 November 2026', start: '10:00', end: '11:00', treatments: undefined, total: '£85.50', status: 'Confirmed', payment: 'Paid' })
  })
})
