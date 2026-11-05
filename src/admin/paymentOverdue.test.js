import { describe, expect, it } from 'vitest'
import { needsYou, paymentOverdue } from './paymentReviewApi.js'

// 5 Nov 2026, 14:00 in London (GMT).
const now = Date.UTC(2026, 10, 5, 14, 0)
const booking = (method, status, date, start = 600, extra = {}) => ({ booking_status: 'confirmed', date, start_minutes: start, treatment_duration_minutes: 60, booking_payments: { method, status }, ...extra })

describe('a session that has happened but is not paid', () => {
  it('is overdue once the appointment has finished, for a transfer not received or cash not marked received', () => {
    expect(paymentOverdue(booking('bank_transfer', 'awaiting_transfer', '2026-10-30'), now)).toBe(true)
    expect(paymentOverdue(booking('bank_transfer', 'awaiting_verification', '2026-10-30'), now)).toBe(true)
    expect(paymentOverdue(booking('cash', 'approved', '2026-11-05', 600), now)).toBe(true)
    expect(paymentOverdue(booking('cash', 'approved', '2026-11-05', 780), now)).toBe(true)
    expect(paymentOverdue(booking('bank_transfer', 'awaiting_transfer', '2026-10-30', 600, { booking_status: 'completed' }), now)).toBe(true)
  })
  it('is not overdue before the appointment ends, once paid, or when not confirmed', () => {
    expect(paymentOverdue(booking('cash', 'approved', '2026-11-05', 781), now)).toBe(false)
    expect(paymentOverdue(booking('bank_transfer', 'awaiting_transfer', '2026-11-06'), now)).toBe(false)
    expect(paymentOverdue(booking('bank_transfer', 'paid', '2026-10-30'), now)).toBe(false)
    expect(paymentOverdue(booking('cash', 'paid', '2026-10-30'), now)).toBe(false)
    expect(paymentOverdue(booking('bank_transfer', 'awaiting_transfer', '2026-10-30', 600, { booking_status: 'awaiting_transfer' }), now)).toBe(false)
    expect(paymentOverdue(booking('bank_transfer', 'awaiting_transfer', '2026-10-30', 600, { booking_status: 'cancelled' }), now)).toBe(false)
    expect(paymentOverdue({ booking_status: 'confirmed', date: '2026-10-30', booking_payments: null }, now)).toBe(false)
  })
  it('needs the Admin, while a transfer the client has not declared before the session does not', () => {
    expect(needsYou(booking('bank_transfer', 'awaiting_transfer', '2020-01-01'))).toBe(true)
    expect(needsYou(booking('bank_transfer', 'awaiting_transfer', '2999-01-01', 600, { booking_status: 'awaiting_transfer' }))).toBe(false)
  })
})
