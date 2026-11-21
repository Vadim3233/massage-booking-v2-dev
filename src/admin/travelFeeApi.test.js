import { describe, expect, it, vi } from 'vitest'
import { canRemoveTravelFee, createTravelFeeApi, travelFeeBlock, travelFeeOutcome } from './travelFeeApi.js'
import { describeLine } from './activityLine.js'
import { shiftDate, today } from './calendarPresentation.js'

// Fash's booking once the transfer is checked: £180 + £20 travel, paid.
const booking = (overrides = {}) => ({ id: 'b1', updated_at: '2031-01-01T10:00:00Z', booking_status: 'confirmed', date: shiftDate(today(), 8),
  start_minutes: 900, total_gbp: 200, travel_fee_gbp: 20, congestion_fee_gbp: 0, gift_covered_gbp: 0, balance_due_gbp: 0,
  booking_payments: { method: 'bank_transfer', status: 'paid', amount_gbp: 200 }, ...overrides })

describe('when Remove travel fee shows', () => {
  it('on a booking still to happen with a travel fee', () => {
    expect(canRemoveTravelFee(booking())).toBe(true)
    for (const status of ['awaiting_transfer', 'awaiting_cash_approval']) expect(canRemoveTravelFee(booking({ booking_status: status, booking_payments: { status: 'awaiting_transfer', amount_gbp: 200 } }))).toBe(true)
  })
  it('not without a fee, once started, or on a booking that is over or cancelled', () => {
    expect(travelFeeBlock(booking({ travel_fee_gbp: 0 }))).toBeNull()
    expect(travelFeeBlock(booking({ date: shiftDate(today(), -1) }))).toBeNull()
    for (const status of ['completed', 'cancelled', 'no_show']) expect(travelFeeBlock(booking({ booking_status: status }))).toBeNull()
    expect(travelFeeBlock(booking({ booking_payments: [{ status: 'refunded', amount_gbp: 200 }] }))).toBeNull()
  })
  it('asks for money said to be sent to be checked first', () => {
    expect(travelFeeBlock(booking({ booking_status: 'awaiting_payment_verification', booking_payments: { status: 'awaiting_verification', amount_gbp: 200 } }))).toMatch(/press Mark paid above/)
    expect(travelFeeBlock(booking({ total_gbp: 260, balance_due_gbp: 60, balance_reported_at: '2031-01-01T09:00:00Z' }))).toMatch(/Mark it received first/)
  })
  it('says why when nothing would be left to pay', () => {
    expect(travelFeeBlock(booking({ gift_covered_gbp: 190 }))).toMatch(/nothing left to pay/)
    expect(travelFeeBlock(booking({ gift_covered_gbp: 180 }))).toMatch(/nothing left to pay/)
    expect(travelFeeBlock(booking({ gift_covered_gbp: 180, booking_payments: { method: 'bank_transfer', status: 'awaiting_transfer', amount_gbp: 20 } }))).toMatch(/nothing left to pay/)
    expect(canRemoveTravelFee(booking({ gift_covered_gbp: 100, booking_payments: { method: 'bank_transfer', status: 'awaiting_transfer', amount_gbp: 100 } }))).toBe(true)
  })
})

describe('what it does to the money', () => {
  it('paid: a refund to send', () => {
    const outcome = travelFeeOutcome(booking())
    expect(outcome.refund).toBe(20)
    expect(outcome.text).toBe('The price goes from £200.00 to £180.00. They have already paid, so £20.00 shows as a refund to send until you press Record refund sent.')
  })
  it('not paid yet: they pay less', () => {
    expect(travelFeeOutcome(booking({ booking_payments: { method: 'bank_transfer', status: 'awaiting_transfer', amount_gbp: 200 } })))
      .toEqual({ refund: 0, text: 'The price goes from £200.00 to £180.00. The client then pays £180.00.' })
    expect(travelFeeOutcome(booking({ booking_payments: { method: 'cash', status: 'approved', amount_gbp: 200 } })).text).toMatch(/pays £180.00 in cash\.$/)
  })
  it('paid with extra still owed: that comes off first', () => {
    const outcome = travelFeeOutcome(booking({ total_gbp: 205, balance_due_gbp: 5, booking_payments: { status: 'paid', amount_gbp: 200 } }))
    expect(outcome.refund).toBe(15)
    expect(outcome.text).toMatch(/£5.00 comes off what they still had to pay\. They have already paid, so £15.00 shows as a refund/)
    expect(travelFeeOutcome(booking({ total_gbp: 230, balance_due_gbp: 30, booking_payments: { status: 'paid', amount_gbp: 200 } })).refund).toBe(0)
  })
})

describe('the calls', () => {
  it('sends the booking, its last change and the message choice', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'b1', error: null })
    await createTravelFeeApi({ rpc }).remove(booking(), 'r1', false)
    expect(rpc).toHaveBeenCalledWith('admin_remove_travel_fee', { p_booking_id: 'b1', p_request_id: 'r1', p_booking_updated_at: '2031-01-01T10:00:00Z', p_notify_client: false })
  })
  it('passes on its own refusals and turns a clash into a reload', async () => {
    const refusal = { code: '22023', message: 'The appointment has already started, so its travel fee stays.' }
    await expect(createTravelFeeApi({ rpc: vi.fn().mockResolvedValue({ error: refusal }) }).remove(booking(), 'r1')).rejects.toThrow(refusal.message)
    const clash = createTravelFeeApi({ rpc: vi.fn().mockResolvedValue({ error: { code: 'PT409', message: 'Booking state changed' } }) }).remove(booking(), 'r1')
    await expect(clash).rejects.toMatchObject({ conflict: true })
    await expect(createTravelFeeApi({ rpc: vi.fn().mockResolvedValue({ error: { code: 'XX000', message: 'secret detail' } }) }).remove(booking(), 'r1')).rejects.toThrow(/Could not remove the travel fee/)
  })
  it('lists upcoming bookings with a fee, leaving out ones already started', async () => {
    const rows = [booking({ id: 'today-past', date: today(), start_minutes: 0 }), booking({ id: 'later' })]
    const query = { select: vi.fn(() => query), eq: vi.fn(() => query), gt: vi.fn(() => query), in: vi.fn(() => query), gte: vi.fn(() => query), order: vi.fn(() => query),
      then: resolve => resolve({ data: rows, error: null }) }
    const list = await createTravelFeeApi({ from: vi.fn(() => query) }).upcoming('c1')
    expect(list.map(row => row.id)).toEqual(['later'])
    expect(query.eq).toHaveBeenCalledWith('client_id', 'c1')
    expect(query.gt).toHaveBeenCalledWith('travel_fee_gbp', 0)
  })
})

describe('the History line', () => {
  it('says the fee, the new price and any refund', () => {
    const line = describeLine({ event_type: 'booking.travel_fee_removed', actor: 'admin', payload: { travel_fee_gbp: 20, total_gbp: 180, refund_added_gbp: 20 } })
    expect(line.what).toMatch(/^Travel fee removed · £20/)
    expect(line.amount).toMatch(/£180/)
    expect(line.tags.map(tag => tag.text)).toEqual([expect.stringMatching(/^refund £20/)])
  })
})
