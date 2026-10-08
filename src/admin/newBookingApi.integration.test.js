import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newBookingFixture } from '../../tests/newBookingFixture.js'
import { unwrap } from '../client/booking/bookingApi.js'
import { emptyAdminDraft } from './adminBookingDraft.js'
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
    f.trackRecipient(created.client_id)
    expect(await api.createClient(details, id)).toEqual(created)
    const client = await unwrap(f.admin.from('clients').select().eq('id', created.client_id).single())
    expect(client.auth_user_id).toBeNull()
    expect(await api.addresses(created.client_id)).toEqual(expect.arrayContaining([expect.objectContaining({ address_line_1: details.address_line_1, is_default: true })]))
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


})
