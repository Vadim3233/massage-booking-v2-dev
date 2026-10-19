import { describe, expect, it } from 'vitest'
import { cancelOutcome } from './cancelOutcome.js'

const booking = (payment, first = 'Andreas') => ({ clients: { first_name: first }, booking_payments: payment })
const paid = { status: 'paid', amount_gbp: 90 }

describe('what cancelling does to the money', () => {
  it('a paid booking with no fee: a full refund', () => {
    expect(cancelOutcome(booking(paid), 0)).toEqual({ text: 'No cancellation fee – Andreas gets a full £90.00 refund', refund: 90 })
  })
  it('a paid booking with a fee: the fee is kept and the rest refunded', () => {
    expect(cancelOutcome(booking(paid), 45)).toEqual({ text: 'Late cancellation – you keep £45.00, refund £45.00', refund: 45 })
  })
  it('a paid booking with the full price as the fee: nothing to refund', () => {
    expect(cancelOutcome(booking(paid), 90)).toEqual({ text: 'Late cancellation – you keep the full £90.00, nothing to refund', refund: 0 })
  })
  it('an unpaid booking: nothing to refund, and a fee is recorded as due', () => {
    for (const status of ['awaiting_transfer', 'awaiting_verification', 'awaiting_approval', 'approved']) {
      expect(cancelOutcome(booking({ status, amount_gbp: 90 }), 0)).toEqual({ text: 'No money has been paid – nothing to refund', refund: 0 })
    }
    expect(cancelOutcome(booking({ status: 'awaiting_transfer', amount_gbp: 90 }), 30).text).toBe('No money has been paid – nothing to refund. A late fee of £30.00 is recorded as due')
  })
  it('reads a payment given as a list, and a client with no first name', () => {
    expect(cancelOutcome({ booking_payments: [paid] }, '').text).toBe('No cancellation fee – The client gets a full £90.00 refund')
  })
})
