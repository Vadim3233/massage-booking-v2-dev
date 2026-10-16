import { describe, expect, it } from 'vitest'
import { paymentLine } from './paymentLine.js'

const row = (overrides = {}) => ({
  booking_status: 'confirmed', total_gbp: 90, payment_method: 'bank_transfer', payment_status: 'paid',
  late_fee_status: 'none', late_fee_due_gbp: null, refund_due_gbp: null, ...overrides,
})

describe('the payment line under a booking in Your bookings', () => {
  it('says a bank transfer that has arrived is paid', () => {
    expect(paymentLine(row())).toEqual({ text: '£90.00 · Paid', tone: 'ok' })
    expect(paymentLine(row({ booking_status: 'completed', total_gbp: 125 }))).toEqual({ text: '£125.00 · Paid', tone: 'ok' })
  })

  it('tells a cash booking to bring the money, and stops once the appointment is behind them', () => {
    const cash = row({ payment_method: 'cash', payment_status: 'approved', total_gbp: 125 })
    expect(paymentLine(cash, { upcoming: true })).toEqual({ text: '£125.00 · Pay in cash at your appointment', tone: 'due' })
    expect(paymentLine(cash, { upcoming: false })).toEqual({ text: '£125.00 · Cash', tone: '' })
    expect(paymentLine(cash)).toEqual({ text: '£125.00 · Cash', tone: '' })
  })

  it('keeps cash that the Admin has not yet agreed to neutral', () => {
    expect(paymentLine(row({ booking_status: 'awaiting_cash_approval', payment_method: 'cash', payment_status: 'awaiting_approval', total_gbp: 60 }), { upcoming: true })).toEqual({ text: '£60.00 · Cash', tone: '' })
  })

  it('says what is still to pay by bank transfer, and shows only the amount once the transfer has been sent', () => {
    expect(paymentLine(row({ booking_status: 'awaiting_transfer', payment_status: 'awaiting_transfer' }), { upcoming: true })).toEqual({ text: '£90.00 to pay by bank transfer', tone: 'due' })
    expect(paymentLine(row({ booking_status: 'awaiting_payment_verification', payment_status: 'awaiting_verification' }), { upcoming: true })).toEqual({ text: '£90.00', tone: '' })
  })

  it('says a refund is on its way until it is sent, then that it was refunded', () => {
    expect(paymentLine(row({ booking_status: 'cancelled', refund_due_gbp: 90 }))).toEqual({ text: 'Refund of £90.00 on its way', tone: 'due' })
    expect(paymentLine(row({ booking_status: 'cancelled', payment_status: 'refunded' }))).toEqual({ text: 'Refunded', tone: '' })
  })

  it('says a late fee is due, on a cancelled booking and on one that was moved late', () => {
    const fee = { late_fee_status: 'due', late_fee_due_gbp: 20 }
    expect(paymentLine(row({ booking_status: 'cancelled', ...fee }))).toEqual({ text: 'Late fee of £20.00 due', tone: 'due' })
    expect(paymentLine(row({ ...fee }), { upcoming: true })).toEqual({ text: '£90.00 · Paid · Late fee of £20.00 due', tone: 'due' })
  })

  it('says both when a refund and a late fee are owed', () => {
    expect(paymentLine(row({ booking_status: 'cancelled', refund_due_gbp: 40, late_fee_status: 'due', late_fee_due_gbp: 20 })))
      .toEqual({ text: 'Refund of £40.00 on its way · Late fee of £20.00 due', tone: 'due' })
  })

  it('says nothing about a cancelled booking where nothing is owed either way', () => {
    expect(paymentLine(row({ booking_status: 'cancelled', payment_status: 'rejected' }))).toBeNull()
    expect(paymentLine(row({ booking_status: 'cancelled', payment_status: 'paid', refund_due_gbp: 0 }))).toBeNull()
    expect(paymentLine(row({ booking_status: 'cancelled', payment_status: 'awaiting_transfer' }))).toBeNull()
  })

  it('says nothing more about a late fee that was received or waived', () => {
    expect(paymentLine(row({ booking_status: 'cancelled', late_fee_status: 'received', late_fee_due_gbp: 20 }))).toBeNull()
    expect(paymentLine(row({ booking_status: 'cancelled', late_fee_status: 'waived', late_fee_due_gbp: null }))).toBeNull()
  })

  it('does not print an amount it does not have', () => {
    expect(paymentLine(row({ total_gbp: null, payment_status: 'awaiting_transfer' }))).toBeNull()
    expect(paymentLine(row({ total_gbp: 0, payment_status: 'paid' }))).toBeNull()
    expect(paymentLine(row({ payment_status: 'something_new' }))).toBeNull()
  })
})
