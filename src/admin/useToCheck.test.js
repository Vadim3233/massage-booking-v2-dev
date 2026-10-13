import { describe, expect, it } from 'vitest'
import { summariseToCheck } from './useToCheck.js'

const booking = (status, total = '90.00') => ({ total_gbp: total, booking_payments: { status } })

describe('what needs the Admin', () => {
  it('counts declared transfers and cash requests, with their value', () => {
    const result = summariseToCheck([booking('awaiting_verification', '90.00'), booking('awaiting_approval', '125.00'), booking('awaiting_transfer', '60.00')])
    expect(result.needs).toHaveLength(2)
    expect(result.total).toBe(215)
    expect(result.waiting).toBe(1)
    expect(result.loaded).toBe(true)
  })
  it('is empty and loaded when nothing is waiting', () => {
    expect(summariseToCheck([])).toEqual({ needs: [], waiting: 0, total: 0, loaded: true })
  })
  it('does not count a booking whose payment has no status', () => {
    expect(summariseToCheck([{ total_gbp: '10', booking_payments: null }]).needs).toEqual([])
  })
})
