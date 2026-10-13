import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newBookingFixture } from '../../tests/newBookingFixture.js'
import { unwrap } from '../client/booking/bookingApi.js'
import { emptyAdminDraft } from './adminBookingDraft.js'
import { shiftDate } from './calendarPresentation.js'
import { bookingRequest, createAdminNewBookingApi } from './newBookingApi.js'

describe('Admin New Booking adapter against local Supabase', () => {
  let f, api, draft
  beforeAll(async () => {
    f = await newBookingFixture(36)
    api = createAdminNewBookingApi(f.client)
    draft = { ...emptyAdminDraft(f.date), client: f.recipient, areaId: f.ids.area, serviceId: f.ids.service,
      details: { ...f.addresses[0], savedAddressId: f.addresses[0].id },
      sessions: [{ duration_minutes: 60, recipient_name: 'First recipient', preference_ids: [f.ids.preference] }],
      enhancementIds: [f.ids.enhancement], note: 'Persist this Admin note',
    }
  }, 30000)
  afterAll(async () => { await f?.cleanup() }, 30000)

  it('uses bounded canonical search and only the selected client addresses', async () => {
    expect((await api.search('')).length).toBeLessThanOrEqual(30)
    const rows = await api.search(f.recipient.email)
    expect(rows.map(row => row.id)).toEqual([f.recipient.id])
    expect((await api.addresses(f.recipient.id)).map(row => row.id).sort()).toEqual(f.addresses.map(row => row.id).sort())
    await expect(createAdminNewBookingApi(f.publicClient).search('')).rejects.toBeDefined()
  })

  it('quotes catalogue fees and separate sessions without trusting browser prices', async () => {
    expect((await api.catalogue()).services.some(row => row.id === f.ids.service)).toBe(true)
    expect(await api.quote(draft)).toMatchObject({ treatment_duration_minutes: 60, total_gbp: 115, enhancements_total_gbp: 10 })
    const multi = { ...draft, sessions: [...draft.sessions, { duration_minutes: 90, recipient_name: 'Second recipient', preference_ids: [] }] }
    expect(await api.quote(multi)).toMatchObject({ treatment_duration_minutes: 150, total_gbp: 230 })
  })

  it('creates canonical clients without auth accounts and exposes duplicate conflicts', async () => {
    const details = { first_name: 'Inline', last_name: 'Created', email: `inline-${crypto.randomUUID()}@example.test`,
      address_line_1: '22 Created Road', city: 'London', postcode: 'SW1A 1AA', entry_instructions: 'Ring twice' }
    const id = crypto.randomUUID()
    const created = await api.createClient(details, id)
    f.trackRecipient(created.id)
    expect(await api.createClient(details, id)).toEqual(created)
    const client = await unwrap(f.admin.from('clients').select().eq('id', created.id).single())
    expect(client.auth_user_id).toBeNull()
    expect(await api.addresses(created.id)).toEqual(expect.arrayContaining([expect.objectContaining({ address_line_1: details.address_line_1, is_default: true })]))
    await expect(api.createClient({ ...details, email: details.email.toUpperCase() }, crypto.randomUUID())).rejects.toBeDefined()
  })

  it('rejects stale slots occupied by a real public hold without creating a booking', async () => {
    const slots = await api.availability(f.date, 60)
    const start = slots[0].start_minutes
    const key = f.key()
    const hold = await f.publicApi.hold(f.date, start, 60, key)
    const before = await unwrap(f.admin.from('bookings').select('id').eq('client_id', f.recipient.id))
    await expect(api.create(bookingRequest({ ...draft, start }), crypto.randomUUID())).rejects.toBeDefined()
    expect(await unwrap(f.admin.from('bookings').select('id').eq('client_id', f.recipient.id))).toEqual(before)
    await f.publicApi.release(hold, key)
  })

  it.each([
    ['bank_pending', 'bank_transfer', 'awaiting_transfer', false],
    ['bank_received', 'bank_transfer', 'paid', true],
    ['cash_appointment', 'cash', 'approved', false],
    ['cash_received', 'cash', 'paid', true],
  ])('persists %s and makes concurrent identical retries exactly once', async (payment, method, status, paid) => {
    const slots = await api.availability(f.date, 60)
    expect(slots.length).toBeGreaterThan(0)
    const request = bookingRequest({ ...draft, start: slots[0].start_minutes, payment })
    const key = crypto.randomUUID()
    const results = await Promise.all([api.create(request, key), api.create(request, key)])
    expect(results[0]).toEqual(results[1])
    const booking = await unwrap(f.admin.from('bookings').select('*,booking_payments(*),booking_sessions(*)').eq('id', results[0].booking_id).single())
    expect(booking).toMatchObject({ booking_status: 'confirmed', source_channel: 'admin', created_by_actor_type: 'admin', created_by_actor_id: f.user.id, total_gbp: 115, address_line_1_snapshot: '10 Saved Street' })
    expect(booking.booking_payments).toMatchObject({ method, status })
    expect(Boolean(booking.booking_payments.paid_at)).toBe(paid)
    expect(booking.booking_sessions).toHaveLength(1)
    expect(await unwrap(f.admin.from('event_outbox').select('id').eq('aggregate_id', booking.id))).toHaveLength(1)
    expect(await unwrap(f.admin.from('command_requests').select('id').eq('idempotency_key', key))).toHaveLength(1)
    await expect(api.create({ ...request, note: 'Different request' }, key)).rejects.toBeDefined()
  })

  // By now the day holds the four appointments made above: 10:00, 12:00, 14:00 and 16:00, each an hour long, her hours being 10:00 to 22:00.
  it('lists every time of a day, marking the usual ones and the ones that overlap another appointment', async () => {
    const day = await api.times(f.date, 60)
    expect(day.working).toEqual({ open: true, start: 600, end: 1320 })
    expect(day.buffer_minutes).toBe(60)
    expect(day.booked.map(item => item.start)).toEqual([600, 720, 840, 960])
    const slot = start => day.slots.find(item => item.start === start)
    expect(slot(630)).toMatchObject({ clash: true, usual: false })
    expect(slot(660)).toMatchObject({ clash: false, usual: false })
    expect(day.slots.filter(item => item.usual).map(item => item.start)).toEqual((await api.availability(f.date, 60)).map(row => row.start_minutes))
    await expect(createAdminNewBookingApi(f.publicClient).times(f.date, 60)).rejects.toBeDefined()
  })

  it('makes a booking at a time the booking page would not offer, but never on top of another appointment', async () => {
    const created = await api.create(bookingRequest({ ...draft, start: 660, anyTime: true }), crypto.randomUUID())
    expect(await unwrap(f.admin.from('bookings').select('start_minutes,travel_buffer_minutes,booking_status').eq('id', created.booking_id).single()))
      .toMatchObject({ start_minutes: 660, travel_buffer_minutes: 60, booking_status: 'confirmed' })
    // Without saying so, a time that is not a usual one is still refused.
    await expect(api.create(bookingRequest({ ...draft, start: 1050 }), crypto.randomUUID())).rejects.toThrow('This time is no longer available. Choose another time.')
    // On top of another appointment it is refused, in plain words.
    await expect(api.create(bookingRequest({ ...draft, start: 630, anyTime: true }), crypto.randomUUID())).rejects.toThrow('That time overlaps another appointment, so it is not available. Choose another time.')
    // Before her working hours and after them.
    await api.create(bookingRequest({ ...draft, start: 480, anyTime: true }), crypto.randomUUID())
    await api.create(bookingRequest({ ...draft, start: 1380, anyTime: true }), crypto.randomUUID())
    // A repeat cannot start from an unusual time.
    await expect(api.createSeries(bookingRequest({ ...draft, start: 1050, anyTime: true }), null, crypto.randomUUID())).rejects.toThrow('A repeat uses the usual times only')
  })

  it('does not offer clients a time before her working hours because the Admin booked one', async () => {
    const other = shiftDate(f.date, 1)
    await unwrap(f.admin.from('working_hours_overrides').upsert({ date: other, available: true, start_minutes: 600, end_minutes: 1320, start_mode: 'flexible', fixed_start_minutes: null }))
    try {
      expect((await f.publicApi.availability(other, 60)).length).toBeGreaterThan(0)
      await api.create(bookingRequest({ ...draft, date: other, start: 360, anyTime: true }), crypto.randomUUID())
      // 06:00 to 07:00 was booked; the next usual time would have been 08:00, which is before her day starts.
      expect(await f.publicApi.availability(other, 60)).toEqual([])
      expect(await api.availability(other, 60)).toEqual([])
    } finally { await f.admin.from('working_hours_overrides').delete().eq('date', other) }
  })

  // A client's held time is only confirmed if it is still a usual time when they press Confirm; an unusual booking elsewhere could take that away.
  it('makes an unusual time wait while a client is part-way through booking that day, and works again when they are done', async () => {
    const other = shiftDate(f.date, 2)
    await unwrap(f.admin.from('working_hours_overrides').upsert({ date: other, available: true, start_minutes: 600, end_minutes: 1320, start_mode: 'flexible', fixed_start_minutes: null }))
    const key = f.key()
    try {
      const start = (await api.availability(other, 60))[0].start_minutes
      const hold = await f.publicApi.hold(other, start, 60, key)
      expect((await api.times(other, 60)).client_booking).toBe(true)
      await expect(api.create(bookingRequest({ ...draft, date: other, start: 1080, anyTime: true }), crypto.randomUUID())).rejects.toThrow('A client is in the middle of booking that day. Try again in a few minutes.')
      await f.publicApi.release(hold, key)
      expect((await api.times(other, 60)).client_booking).toBe(false)
      await api.create(bookingRequest({ ...draft, date: other, start: 1080, anyTime: true }), crypto.randomUUID())
    } finally { await f.admin.from('working_hours_overrides').delete().eq('date', other) }
  })

  it('makes one booking when the same unusual request arrives twice, and refuses a second request for the same time as a double booking', async () => {
    const other = shiftDate(f.date, 3)
    await unwrap(f.admin.from('working_hours_overrides').upsert({ date: other, available: true, start_minutes: 600, end_minutes: 1320, start_mode: 'flexible', fixed_start_minutes: null }))
    try {
      const request = bookingRequest({ ...draft, date: other, start: 660, anyTime: true })
      const same = crypto.randomUUID()
      const twice = await Promise.all([api.create(request, same), api.create(request, same)])
      expect(twice[0]).toEqual(twice[1])
      expect(await unwrap(f.admin.from('bookings').select('id').eq('client_id', f.recipient.id).eq('date', other))).toHaveLength(1)
      const rivals = await Promise.allSettled([900, 900].map(start => api.create(bookingRequest({ ...draft, date: other, start, anyTime: true }), crypto.randomUUID())))
      expect(rivals.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(rivals.find(result => result.status === 'rejected').reason.message).toBe('That time overlaps another appointment, so it is not available. Choose another time.')
    } finally { await f.admin.from('working_hours_overrides').delete().eq('date', other) }
  })
})
