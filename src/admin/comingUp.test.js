import { describe, expect, it } from 'vitest'
import { comingUp, needsYou, owesExtra } from './paymentReviewApi.js'
import { howSoon } from './reviewClients.js'

// 23 Nov 2026, 19:20 in London (GMT).
const now = Date.UTC(2026, 10, 23, 19, 20)
const booking = (method, status, date, start = 1140, extra = {}) => ({ booking_status: 'confirmed', date, start_minutes: start, treatment_duration_minutes: 120, booking_payments: { method, status }, ...extra })

describe('a confirmed booking not paid yet, before its session', () => {
  it('is coming up from the moment it is confirmed, including a session still running', () => {
    expect(comingUp(booking('bank_transfer', 'awaiting_transfer', '2026-11-29'), now)).toBe(true)
    expect(comingUp(booking('bank_transfer', 'awaiting_transfer', '2026-11-23', 1140), now)).toBe(true) // 19:00-21:00, now 19:20
  })
  it('moves to Needs you once the session ends', () => {
    expect(comingUp(booking('bank_transfer', 'awaiting_transfer', '2026-11-23', 1020), now)).toBe(false) // 17:00-19:00
    expect(needsYou(booking('bank_transfer', 'awaiting_transfer', '2026-11-23', 1020))).toBe(true)
  })
  it('needs the Admin at once when the client says they paid', () => {
    const said = booking('bank_transfer', 'awaiting_verification', '2026-11-29')
    expect(comingUp(said, now)).toBe(false)
    expect(needsYou(said)).toBe(true)
  })
  it('leaves cash out before the session (paid on the day)', () => {
    expect(comingUp(booking('cash', 'approved', '2026-11-29'), now)).toBe(false)
    expect(needsYou(booking('cash', 'approved', '2999-11-29'))).toBe(false)
  })
  it('leaves out bookings not confirmed, cancelled or paid', () => {
    expect(comingUp(booking('bank_transfer', 'awaiting_transfer', '2026-11-29', 600, { booking_status: 'awaiting_transfer' }), now)).toBe(false)
    expect(comingUp(booking('bank_transfer', 'awaiting_transfer', '2026-11-29', 600, { booking_status: 'cancelled' }), now)).toBe(false)
    expect(comingUp(booking('bank_transfer', 'paid', '2026-11-29'), now)).toBe(false)
  })
  it('lists an extra still owed on a paid booking, until the client says it is sent', () => {
    const extra = booking('bank_transfer', 'paid', '2026-11-29', 600, { balance_due_gbp: '45.00' })
    expect(owesExtra(extra)).toBe(true)
    expect(comingUp(extra, now)).toBe(true)
    expect(comingUp({ ...extra, balance_reported_at: '2026-11-23T10:00:00Z' }, now)).toBe(false)
  })
})

describe('how soon', () => {
  it('says today, tomorrow or in N days', () => {
    expect(howSoon('2026-11-23', '2026-11-23')).toBe('today')
    expect(howSoon('2026-11-24', '2026-11-23')).toBe('tomorrow')
    expect(howSoon('2026-11-29', '2026-11-23')).toBe('in 6 days')
  })
})
