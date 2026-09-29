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
  it('creates a real pre-auth twenty-minute hold from public availability', async () => {
    const slots = await fixture.publicApi.availability(draft.date, 120)
    draft.start = slots[0].start_minutes
    const before = Date.now()
    draft.hold = await fixture.publicApi.hold(draft.date, draft.start, 120, key)
    expect(Date.parse(draft.hold.expires_at) - before).toBeGreaterThan(1190000)
    expect(Date.parse(draft.hold.expires_at) - before).toBeLessThan(1210000)
    expect((await fixture.publicApi.availability(draft.date, 120)).some((slot) => slot.start_minutes === draft.start)).toBe(false)
  })
  it('returns owner-aware alternatives over real HTTP and rejects forged identity', async () => {
    const full = Array.from({ length: 21 }, (_, i) => ({ start_minutes: 600 + i * 30 }))
    expect(await fixture.publicApi.availability(draft.date, 120, draft.hold, key)).toEqual(full)
    expect(await fixture.publicApi.availability(draft.date, 120)).toEqual([{ start_minutes: 780 }])
    await expect(fixture.publicApi.availability(draft.date, 120, { ...draft.hold, hold_token: crypto.randomUUID() }, key)).rejects.toMatchObject({ code: '42501' })
    await expect(fixture.publicApi.availability(draft.date, 120, draft.hold, fixture.key())).rejects.toMatchObject({ code: '42501' })
    const otherKey = fixture.key()
    const other = await fixture.publicApi.hold(draft.date, 780, 120, otherKey)
    expect(await fixture.publicApi.availability(draft.date, 120, draft.hold, key)).toEqual([{ start_minutes: 600 }, { start_minutes: 960 }])
    await fixture.publicApi.release(other, otherKey)
    const original = draft.hold
    draft.hold = await fixture.publicApi.hold(draft.date, 630, 120, key)
    draft.start = 630
    expect((await unwrap(fixture.admin.from('booking_holds').select('status').eq('id', original.hold_id)))[0].status).toBe('released')
    expect(await fixture.api.availability(draft.date, 120, draft.hold, key)).toEqual(full)
    await expect(fixture.publicApi.availability(draft.date, 120, original, key)).rejects.toMatchObject({ code: '42501' })
  })
  it('extends once under concurrent retries and keeps the slot unavailable', async () => {
    const before = await unwrap(fixture.admin.from('booking_holds').select('id,status').eq('client_key', key))
    await expect(fixture.publicApi.extend({ ...draft.hold, hold_token: crypto.randomUUID() }, key)).rejects.toMatchObject({ code: '42501' })
    await expect(fixture.publicApi.extend(draft.hold, fixture.key())).rejects.toMatchObject({ code: '42501' })
    const responses = await Promise.all([fixture.publicApi.extend(draft.hold, key), fixture.api.extend(draft.hold, key)])
    expect(responses[0]).toEqual(responses[1])
    expect(Date.parse(responses[0].expires_at) - Date.parse(draft.hold.expires_at)).toBe(600000)
    expect(await fixture.publicApi.extend(draft.hold, key)).toEqual(responses[0])
    const repeated = await fixture.publicApi.hold(draft.date, draft.start, 120, key)
    expect(repeated).toEqual({ ...draft.hold, expires_at: responses[0].expires_at })
    expect(await unwrap(fixture.admin.from('booking_holds').select('id,status').eq('client_key', key))).toEqual(before)
    expect(before.filter((hold) => hold.status === 'active')).toHaveLength(1)
    expect((await fixture.publicApi.availability(draft.date, 120)).some((slot) => slot.start_minutes === draft.start)).toBe(false)
    draft.hold = { ...draft.hold, ...responses[0] }
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
    expect(result).toMatchObject({ total_gbp: 200, booking_status: 'awaiting_transfer', payment_status: 'awaiting_transfer' })
    const booking = await fixture.api.booking(result.booking_id)
    expect(booking.booking_sessions.map((session) => session.duration_minutes)).toEqual([60, 60])
    expect(booking.booking_payments.status).toBe('awaiting_transfer')
    expect(booking.booking_email_snapshot).toBe(fixture.email)
    expect(Date.parse(booking.payment_reservation_expires_at) - Date.now()).toBeGreaterThan(3590000)
    expect((await fixture.api.addresses())[0].postcode).toBe('SW1A 1AA')
  })
  it('retries idempotently without duplicate bookings, enhancements or events', async () => {
    await unwrap(fixture.admin.from('services').update({ active: false }).eq('id', fixture.ids.service))
    try { expect(await fixture.api.finalize(params)).toEqual(result) }
    finally { await unwrap(fixture.admin.from('services').update({ active: true }).eq('id', fixture.ids.service)) }
    const bookings = await unwrap(fixture.admin.from('bookings').select('id').eq('client_id', fixture.profile.client_id))
    expect(bookings).toHaveLength(1)
    expect(await unwrap(fixture.admin.from('booking_enhancements').select('id').eq('booking_id', result.booking_id))).toHaveLength(1)
    expect(await unwrap(fixture.admin.from('event_outbox').select('id').eq('aggregate_id', result.booking_id))).toHaveLength(1)
  })
  it('declares the transfer idempotently without marking it paid', async () => {
    const first = await fixture.api.declareTransfer(result.booking_id)
    expect(first.booking_payments.status).toBe('awaiting_verification')
    expect(await fixture.api.declareTransfer(result.booking_id)).toEqual(first)
    const rows = await unwrap(fixture.admin.from('booking_payments').select('paid_at,status').eq('booking_id', result.booking_id))
    expect(rows[0]).toEqual({ paid_at: null, status: 'awaiting_verification' })
  })
  it('rejects token theft and hides private records from anonymous callers', async () => {
    await expect(fixture.publicApi.booking(result.booking_id)).rejects.toBeDefined()
    const ownKey = fixture.key()
    const slots = await fixture.publicApi.availability(draft.date, 60)
    const hold = await fixture.publicApi.hold(draft.date, slots[0].start_minutes, 60, ownKey)
    await expect(fixture.publicApi.release(hold, fixture.key())).rejects.toMatchObject({ code: '42501' })
    await fixture.publicApi.release(hold, ownKey)
  })
  it('rejects expired, released and consumed holds and release frees the slot', async () => {
    await expect(fixture.publicApi.extend(draft.hold, key)).rejects.toMatchObject({ code: '23P01' })
    const ownKey = fixture.key()
    const slots = await fixture.publicApi.availability(draft.date, 60)
    const start = slots[0].start_minutes
    const hold = await fixture.publicApi.hold(draft.date, start, 60, ownKey)
    await fixture.publicApi.release(hold, ownKey)
    await expect(fixture.publicApi.extend(hold, ownKey)).rejects.toMatchObject({ code: '23P01' })
    expect((await fixture.publicApi.availability(draft.date, 60)).some((slot) => slot.start_minutes === start)).toBe(true)
    const next = await fixture.publicApi.hold(draft.date, start, 60, ownKey)
    await unwrap(fixture.admin.from('booking_holds').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', next.hold_id))
    await expect(fixture.publicApi.extend(next, ownKey)).rejects.toMatchObject({ code: '23P01' })
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
