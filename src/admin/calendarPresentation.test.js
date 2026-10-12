import { expect, it } from 'vitest'
import { dayContext, daySummary, nextUp, postcode, shiftDate } from './calendarPresentation.js'
it('handles London calendar dates across DST and month boundaries', () => {
  expect(shiftDate('2026-03-29', 1)).toBe('2026-03-30')
  expect(shiftDate('2026-10-31', 1)).toBe('2026-11-01')
})
it('formats a snapshot postcode without changing stored data', () => { expect(postcode('sw1a1aa')).toBe('SW1A 1AA') })
it('a booking waiting for a transfer keeps occupying displayed gaps, however old', () => {
  const now = Date.now()
  const b = { booking_status: 'awaiting_transfer', start_minutes: 780, treatment_duration_minutes: 60, travel_buffer_minutes: 60 }
  const data = { overrides: [{ date: '2026-10-05', available: true, start_minutes: 600, end_minutes: 1200 }], hours: [], holds: [], blocks: [], bookings: [b] }
  expect(dayContext(data, '2026-10-05', now).gaps).toEqual([[600, 720], [900, 1200]])
})
it('merges overlapping buffers and blocks and ignores expired holds', () => {
  const now = Date.now()
  const data = { overrides: [], hours: [{ weekday: 1, available: true, start_minutes: 600, end_minutes: 1200 }], holds: [{ expires_at: new Date(now - 1).toISOString() }], blocks: [{ start_minutes: 700, end_minutes: 850 }], bookings: [{ booking_status: 'confirmed', start_minutes: 800, treatment_duration_minutes: 60, travel_buffer_minutes: 60 }] }
  expect(dayContext(data, '2026-10-05', now).gaps).toEqual([[600, 700], [920, 1200]])
  expect(dayContext(data, '2026-10-05', now).holds).toEqual([])
})

it('names the appointment happening now, or else the next one going ahead, in London time', () => {
  const make = (id, date, start, status = 'confirmed') => ({ id, date, start_minutes: start, treatment_duration_minutes: 60, booking_status: status })
  const list = [make('done', '2026-10-12', 540), make('cancelled', '2026-10-12', 840, 'cancelled'), make('later', '2026-10-12', 960), make('tomorrow', '2026-10-13', 600)]
  // 14:10 in London (BST, so 13:10 UTC): the cancelled 14:00 is not "now", the 16:00 is next.
  expect(nextUp(list, new Date('2026-10-12T13:10:00Z'))).toEqual({ id: 'later', now: false })
  // 16:30: the 16:00 appointment is under way.
  expect(nextUp(list, new Date('2026-10-12T15:30:00Z'))).toEqual({ id: 'later', now: true })
  // After the last one today, the next is tomorrow's; with nothing ahead there is nothing to name.
  expect(nextUp(list, new Date('2026-10-12T18:30:00Z'))).toEqual({ id: 'tomorrow', now: false })
  expect(nextUp(list, new Date('2026-10-13T12:00:00Z'))).toBeNull()
  expect(nextUp([], new Date())).toBeNull()
})
it('does not count an appointment that has no going-ahead status', () => {
  const missed = { id: 'm', date: '2026-10-12', start_minutes: 960, treatment_duration_minutes: 60, booking_status: 'no_show' }
  expect(nextUp([missed], new Date('2026-10-12T12:00:00Z'))).toBeNull()
})
it('says what a day comes to from the appointments that are going ahead', () => {
  const make = (status, price) => ({ booking_status: status, total_gbp: price })
  expect(daySummary([])).toBe('Free')
  expect(daySummary([make('confirmed', '85.00')])).toBe('1 booking · £85.00')
  expect(daySummary([make('confirmed', '85.00'), make('cancelled', '125.00')])).toBe('1 booking · £85.00')
  expect(daySummary([make('confirmed', '85.00'), make('awaiting_transfer', '90.00')])).toBe('2 bookings · £175.00')
  // A no-show is still an appointment that was made, but it is not worth its price.
  expect(daySummary([make('confirmed', '85.00'), make('no_show', '85.00')])).toBe('2 bookings · £85.00')
  expect(daySummary([make('cancelled', '85.00'), make('cancelled', '90.00')])).toBe('All cancelled')
})
