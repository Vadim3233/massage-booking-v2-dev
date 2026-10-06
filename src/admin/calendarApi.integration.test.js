import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminFixture } from '../../tests/adminFixture.js'
import { createCalendarApi, validateRange } from './calendarApi.js'
import { shiftDate } from './calendarPresentation.js'
let f
beforeAll(async () => { f = await adminFixture() }, 30000)
afterAll(async () => { await f?.cleanup() }, 30000)
describe('Admin real local Supabase reads', () => {
  it('denies unauthenticated reads including direct table access', async () => {
    await expect(createCalendarApi(f.publicClient).loadCalendarRange(f.date, shiftDate(f.date, 1))).rejects.toBeDefined()
    const response = await f.publicClient.from('bookings').select('id').eq('id', f.bookings[0].id)
    expect(response.error || response.data.length === 0).toBeTruthy()
  })
  it('denies a normal client and RLS hides another client booking and related records', async () => {
    await expect(createCalendarApi(f.client).loadCalendarRange(f.date, shiftDate(f.date, 1))).rejects.toThrow('Admin access')
    for (const table of ['bookings', 'booking_sessions', 'booking_payments']) {
      const response = await f.client.from(table).select('id').eq(table === 'bookings' ? 'id' : 'booking_id', f.bookings[0].id)
      expect(response.error).toBeNull(); expect(response.data).toEqual([])
    }
  })
  it('authorized Admin reads only the requested range with correct nested records', async () => {
    await f.authorize()
    const data = await createCalendarApi(f.client).loadCalendarRange(f.date, shiftDate(f.date, 1))
    expect(data.bookings.map(b => b.id)).toEqual(f.bookings.slice(0, 2).map(b => b.id))
    for (const b of data.bookings) { expect(b.booking_sessions[0].booking_id).toBe(b.id); expect(b.booking_payments.booking_id).toBe(b.id); expect(b.clients.email).toBe('canonical@example.test') }
    expect(data.bookings[1].booking_status).toBe('cancelled')
    expect(data.bookings[1].booking_payments.status).toBe('rejected')
  })
  it('rejects unbounded or invalid ranges before requesting data', () => {
    for (const [start, end] of [['2026-01-01','2027-01-01'], ['2026-01-01','2026-01-01'], ['2026-02-30','2026-03-03']]) expect(() => validateRange(start, end)).toThrow()
  })
})
