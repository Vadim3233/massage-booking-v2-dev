import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localFixture } from '../../../tests/localSupabase.js'
import { unwrap } from '../booking/bookingApi.js'
import { createAccountApi } from './accountApi.js'

let f, api
const DAY = 86400000
beforeEach(async () => { f = await localFixture(30); api = createAccountApi(f.client) }, 30000)
afterEach(async () => { await f?.cleanup() }, 30000)

async function booking(overrides = {}) {
  const row = await unwrap(f.admin.from('bookings').insert({
    client_id: f.profile.client_id, service_area_id: f.ids.area, date: f.date, start_minutes: 600, treatment_duration_minutes: 60, booking_status: 'confirmed',
    source_channel: 'web', address_line_1_snapshot: '1 Test Road', city_snapshot: 'London', postcode_snapshot: 'SW1A1AA', service_area_name_snapshot: 'Integration area',
    service_subtotal_gbp: 85, total_gbp: 85, booking_email_snapshot: f.email, booking_reference: `ACC-${crypto.randomUUID()}`, ...overrides }).select().single())
  await unwrap(f.admin.from('booking_sessions').insert({ booking_id: row.id, position: 1, service_id: f.ids.service, duration_minutes: 60, service_name_snapshot: 'Integration massage', unit_price_gbp: 85 }))
  await unwrap(f.admin.from('booking_payments').insert({ booking_id: row.id, method: 'cash', status: 'approved', amount_gbp: 85 }))
  return row
}

describe('a client managing their own booking against local Supabase', () => {
  it('lists the booking and explains the terms from the database', async () => {
    const b = await booking()
    const rows = await api.list()
    expect(rows.map(row => row.id)).toEqual([b.id])
    const terms = await api.terms(b.id)
    expect(terms).toMatchObject({ can_change: true, cancel_fee_gbp: 0, reschedule_fee_gbp: 0 })
    expect(Date.parse(terms.free_until)).toBeGreaterThan(Date.now())
  })

  it('moves a booking to an offered time without a fee', async () => {
    const b = await booking()
    const times = await api.availability(b.id, f.date)
    expect(times.length).toBeGreaterThan(1)
    const target = times.find(minutes => minutes !== 600)
    const result = await api.reschedule(b.id, crypto.randomUUID(), f.date, target, 0)
    expect(result.start_minutes).toBe(target)
    expect(result.late_fee_status).toBe('none')
  })

  it('cancels, and a repeat is safe but a second different cancel is refused kindly', async () => {
    const b = await booking(), key = crypto.randomUUID()
    expect((await api.cancel(b.id, key, 0, 'Plans changed')).booking_status).toBe('cancelled')
    expect((await api.cancel(b.id, key, 0, 'Plans changed')).booking_status).toBe('cancelled')
    await expect(api.cancel(b.id, crypto.randomUUID(), 0)).rejects.toThrow('This booking can no longer be changed online. Please contact Vad.')
    expect((await f.admin.from('event_outbox').select('id').eq('aggregate_id', b.id).eq('event_type', 'booking.cancelled')).data).toHaveLength(1)
  })

  it('inside 24 hours the client must acknowledge the exact fee', async () => {
    const soon = new Date(Date.now() + 5 * 3600000)
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(soon).map(part => [part.type, part.value]))
    const b = await booking({ date: `${parts.year}-${parts.month}-${parts.day}`, start_minutes: Math.floor((Number(parts.hour) * 60 + Number(parts.minute)) / 30) * 30, created_at: new Date(Date.now() - 3 * DAY).toISOString() })
    expect((await api.terms(b.id)).cancel_fee_gbp).toBe(85)
    await expect(api.cancel(b.id, crypto.randomUUID(), 0)).rejects.toMatchObject({ message: 'The late fee has changed. Please review it and confirm again.', refresh: true })
    const result = await api.cancel(b.id, crypto.randomUUID(), 85)
    expect(result).toMatchObject({ booking_status: 'cancelled', late_fee_status: 'due', late_fee_due_gbp: 85 })
  })

  it("never shows another client's booking or raw errors", async () => {
    const other = await unwrap(f.admin.from('clients').insert({ first_name: 'Other', last_name: 'Person', email: `other-${crypto.randomUUID()}@example.test` }).select().single())
    try {
      const theirs = await booking({ client_id: other.id })
      expect(await api.list()).toEqual([])
      await expect(api.terms(theirs.id)).rejects.toThrow('Something went wrong. Please try again, or contact Vad if it keeps happening.')
      await expect(api.cancel(theirs.id, crypto.randomUUID(), 0)).rejects.toThrow('Something went wrong')
    } finally {
      const rows = await unwrap(f.admin.from('bookings').select('id').eq('client_id', other.id))
      for (const row of rows) await f.admin.from('event_outbox').delete().eq('aggregate_id', row.id)
      await f.admin.from('bookings').delete().eq('client_id', other.id)
      await f.admin.from('clients').delete().eq('id', other.id)
    }
  })
})
