import { expect, it } from 'vitest'
import { dayContext, expired, postcode, shiftDate } from './calendarPresentation.js'
it('handles London calendar dates across DST and month boundaries', () => {
  expect(shiftDate('2026-03-29', 1)).toBe('2026-03-30')
  expect(shiftDate('2026-10-31', 1)).toBe('2026-11-01')
})
it('formats a snapshot postcode without changing stored data', () => { expect(postcode('sw1a1aa')).toBe('SW1A 1AA') })
it('expired transfer reservations do not occupy displayed gaps', () => {
  const now = Date.now()
  const b = { booking_status: 'awaiting_transfer', payment_reservation_expires_at: new Date(now - 1).toISOString() }
  expect(expired(b, now)).toBe(true)
  const data = { overrides: [{ date: '2026-10-05', available: true, start_minutes: 600, end_minutes: 1200 }], hours: [], holds: [], blocks: [], bookings: [b] }
  expect(dayContext(data, '2026-10-05', now).gaps).toEqual([[600, 1200]])
})
it('merges overlapping buffers and blocks and ignores expired holds', () => {
  const now = Date.now()
  const data = { overrides: [], hours: [{ weekday: 1, available: true, start_minutes: 600, end_minutes: 1200 }], holds: [{ expires_at: new Date(now - 1).toISOString() }], blocks: [{ start_minutes: 700, end_minutes: 850 }], bookings: [{ booking_status: 'confirmed', start_minutes: 800, treatment_duration_minutes: 60, travel_buffer_minutes: 60 }] }
  expect(dayContext(data, '2026-10-05', now).gaps).toEqual([[600, 700], [920, 1200]])
  expect(dayContext(data, '2026-10-05', now).holds).toEqual([])
})
