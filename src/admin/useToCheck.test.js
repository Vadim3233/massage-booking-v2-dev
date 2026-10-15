import { describe, expect, it } from 'vitest'
import { summariseToCheck } from './useToCheck.js'
import { fingerprint } from './paymentReminders.js'

const booking = (status, total = '90.00', extra = {}) => ({ id: `b-${status}-${total}`, total_gbp: total, updated_at: 'u1', booking_payments: { status, updated_at: 'p1' }, ...extra })

describe('what needs the Admin', () => {
  it('counts declared transfers and cash requests, with their value', () => {
    const result = summariseToCheck([booking('awaiting_verification', '90.00'), booking('awaiting_approval', '125.00'), booking('awaiting_transfer', '60.00')])
    expect(result.needs).toHaveLength(2)
    expect(result.total).toBe(215)
    expect(result.waiting).toBe(1)
    expect(result.snoozed).toEqual([])
    expect(result.loaded).toBe(true)
  })
  it('is empty and loaded when nothing is waiting', () => {
    expect(summariseToCheck([])).toEqual({ needs: [], snoozed: [], waiting: 0, total: 0, loaded: true })
  })
  it('does not count a booking whose payment has no status', () => {
    expect(summariseToCheck([{ total_gbp: '10', booking_payments: null }]).needs).toEqual([])
  })
})

describe('a payment put off with "Not yet"', () => {
  const now = Date.UTC(2026, 10, 3, 12, 0)
  const put = (target, until) => ({ [target.id]: { until, seen: fingerprint(target) } })

  it('leaves the count and the total until its time, and is not mistaken for one waiting for the client', () => {
    const away = booking('awaiting_approval', '125.00')
    const other = booking('awaiting_verification', '90.00')
    const waiting = booking('awaiting_transfer', '60.00')
    const result = summariseToCheck([away, other, waiting], put(away, now + 3600000), now)
    expect(result.needs).toEqual([other])
    expect(result.snoozed).toEqual([away])
    expect(result.total).toBe(90)
    expect(result.waiting).toBe(1)
  })
  it('comes back when its time has come', () => {
    const away = booking('awaiting_approval', '125.00')
    const result = summariseToCheck([away], put(away, now - 1000), now)
    expect(result.needs).toEqual([away])
    expect(result.snoozed).toEqual([])
  })
  it('comes back at once when the booking or its payment changes', () => {
    const away = booking('awaiting_approval', '125.00')
    const saved = put(away, now + 3600000)
    expect(summariseToCheck([{ ...away, updated_at: 'u2' }], saved, now).needs).toHaveLength(1)
    expect(summariseToCheck([{ ...away, booking_payments: { ...away.booking_payments, updated_at: 'p2' } }], saved, now).needs).toHaveLength(1)
  })
})
