import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { localFixture } from '../../../tests/localSupabase.js'
import { finalizeParams, unwrap } from './bookingApi.js'
import { newDraft, newSession } from './bookingDraft.js'

describe('real local Supabase client adapter', () => {
  let fixture, draft, key, params, result
  beforeAll(async () => {
    fixture = await localFixture()
    key = fixture.key()
    draft = { ...newDraft(), areaId: fixture.ids.area, serviceId: fixture.ids.service, date: fixture.date,
      sessions: [newSession(60), newSession(60)], enhancementIds: [fixture.ids.enhancement],
      details: { ...newDraft().details, first_name: 'Test', last_name: 'Client', phone: '+447700900001', address_line_1: '10 Test Street', city: 'London', postcode: 'SW1A 1AA' } }
    draft.sessions[0].preference_ids = [fixture.ids.preference]
  }, 30000)
  afterAll(async () => { await fixture?.cleanup() }, 30000)

  it('reads the actual public catalogue and quote', async () => {
    const catalogue = await fixture.publicApi.catalogue()
    expect(catalogue.services.some((service) => service.id === fixture.ids.service)).toBe(true)
    expect(catalogue.areas.some((area) => area.id === fixture.ids.area)).toBe(true)
    expect(catalogue.preferences.some((item) => item.id === fixture.ids.preference)).toBe(true)
    expect(await fixture.publicApi.quote(draft)).toMatchObject({ treatment_duration_minutes: 120, enhancements_total_gbp: 10, total_gbp: 200 })
  })
  it('creates a real pre-auth ten-minute hold from public availability', async () => {
    const slots = await fixture.publicApi.availability(draft.date, 120)
    draft.start = slots[0].start_minutes
    const before = Date.now()
    draft.hold = await fixture.publicApi.hold(draft.date, draft.start, 120, key)
    expect(Date.parse(draft.hold.expires_at) - before).toBeGreaterThan(590000)
    expect(Date.parse(draft.hold.expires_at) - before).toBeLessThan(610000)
    expect((await fixture.publicApi.availability(draft.date, 120)).some((slot) => slot.start_minutes === draft.start)).toBe(false)
  })
  it('rolls back all writes when session preferences conflict', async () => {
    const invalid = structuredClone(draft)
    invalid.sessions[0].preference_ids.push(fixture.ids.conflicting)
    await expect(fixture.api.finalize(finalizeParams(invalid, key, crypto.randomUUID()))).rejects.toMatchObject({ code: '22023' })
    expect(await unwrap(fixture.admin.from('bookings').select('id').eq('client_id', fixture.profile.client_id))).toEqual([])
    expect(await fixture.api.addresses()).toEqual([])
    const holds = await unwrap(fixture.admin.from('booking_holds').select('status').eq('id', draft.hold.hold_id))
    expect(holds[0].status).toBe('active')
  })
  it('finalizes actual adapter payload with two separate sessions and pending payment', async () => {
    params = finalizeParams(draft, key, crypto.randomUUID())
    result = await fixture.api.finalize(params)
    expect(result).toMatchObject({ total_gbp: 200, booking_status: 'awaiting_payment_verification', payment_status: 'awaiting_verification' })
    const booking = await fixture.api.booking(result.booking_id)
    expect(booking.booking_sessions.map((session) => session.duration_minutes)).toEqual([60, 60])
    expect(booking.booking_payments.status).toBe('awaiting_verification')
    expect((await fixture.api.addresses())[0].postcode).toBe('SW1A 1AA')
  })
  it('retries idempotently without duplicate bookings, enhancements or events', async () => {
    expect(await fixture.api.finalize(params)).toEqual(result)
    const bookings = await unwrap(fixture.admin.from('bookings').select('id').eq('client_id', fixture.profile.client_id))
    expect(bookings).toHaveLength(1)
    expect(await unwrap(fixture.admin.from('booking_enhancements').select('id').eq('booking_id', result.booking_id))).toHaveLength(1)
    expect(await unwrap(fixture.admin.from('event_outbox').select('id').eq('aggregate_id', result.booking_id))).toHaveLength(1)
  })
  it('rejects token theft and hides private records from anonymous callers', async () => {
    await expect(fixture.publicApi.booking(result.booking_id)).rejects.toBeDefined()
    const ownKey = fixture.key()
    const slots = await fixture.publicApi.availability(draft.date, 60)
    const hold = await fixture.publicApi.hold(draft.date, slots[0].start_minutes, 60, ownKey)
    await expect(fixture.publicApi.release(hold, fixture.key())).rejects.toMatchObject({ code: '42501' })
    await fixture.publicApi.release(hold, ownKey)
  })
  it('can request cash for a returning client without marking it paid', async () => {
    await unwrap(fixture.admin.from('bookings').update({ booking_status: 'completed' }).eq('id', result.booking_id))
    await unwrap(fixture.admin.from('booking_payments').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('booking_id', result.booking_id))
    const cashKey = fixture.key()
    const slots = await fixture.publicApi.availability(draft.date, 60)
    const cash = { ...draft, sessions: [newSession(60)], paymentMethod: 'cash', start: slots[0].start_minutes }
    cash.hold = await fixture.publicApi.hold(cash.date, cash.start, 60, cashKey)
    const response = await fixture.api.finalize(finalizeParams(cash, cashKey, crypto.randomUUID()))
    expect(response).toMatchObject({ booking_status: 'awaiting_cash_approval', payment_status: 'awaiting_approval' })
  })
})
