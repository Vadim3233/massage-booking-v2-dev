import { describe, expect, it, vi } from 'vitest'
import { createLifecycleApi, feeChoices, lifecycleActions } from './bookingLifecycleApi.js'
import { shiftDate, today } from './calendarPresentation.js'

const booking = (overrides = {}) => ({ id: 'b1', updated_at: '2031-01-01T10:00:00Z', booking_status: 'confirmed', date: shiftDate(today(), 10), late_fee_status: 'none', refund_due_gbp: 0,
  booking_payments: { status: 'approved', updated_at: '2031-01-01T10:00:01Z' }, ...overrides })

describe('which actions the Admin is offered', () => {
  it('offers change and cancel for confirmed and pending bookings only', () => {
    expect(lifecycleActions(booking())).toEqual(['reschedule', 'cancel'])
    for (const status of ['awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval']) expect(lifecycleActions(booking({ booking_status: status }))).toEqual(['reschedule', 'cancel'])
    for (const status of ['cancelled', 'completed', 'no_show']) expect(lifecycleActions(booking({ booking_status: status }))).toEqual([])
  })
  it('offers completion and no-show once the day has come', () => {
    expect(lifecycleActions(booking({ date: today() }))).toEqual(['complete', 'noShow', 'reschedule', 'cancel'])
    expect(lifecycleActions(booking({ date: shiftDate(today(), -2) }))).toContain('complete')
    expect(lifecycleActions(booking({ booking_status: 'awaiting_cash_approval', date: today() }))).not.toContain('complete')
  })
  it('offers money follow-up only when something is owed', () => {
    expect(lifecycleActions(booking({ booking_status: 'cancelled', refund_due_gbp: '40.00', booking_payments: { status: 'paid' } }))).toEqual(['refund'])
    expect(lifecycleActions(booking({ booking_status: 'cancelled', refund_due_gbp: '0.00', booking_payments: { status: 'paid' } }))).toEqual([])
    expect(lifecycleActions(booking({ booking_status: 'no_show', late_fee_status: 'due' }))).toEqual(['feeReceived', 'feeWaive'])
    expect(lifecycleActions(booking({ booking_status: 'cancelled', late_fee_status: 'received' }))).toEqual([])
  })
})

describe('the usual answers to what late fee', () => {
  it('offers no fee and the full price when the standard fee is nothing or everything', () => {
    expect(feeChoices('cancel', 85, 0).map(choice => choice.text)).toEqual(['No fee', 'Full price £85.00'])
    expect(feeChoices('cancel', 85, 85).map(choice => choice.text)).toEqual(['No fee', 'Full price £85.00'])
    expect(feeChoices('cancel', 85, null).map(choice => choice.value)).toEqual([0, 85])
  })
  it('adds the standard fee when it lies between nothing and the full price', () => {
    expect(feeChoices('cancel', 90, 45)).toEqual([{ value: 0, text: 'No fee' }, { value: 45, text: 'Standard fee £45.00' }, { value: 90, text: 'Full price £90.00' }])
  })
  it('offers a no-show no fee or the full price, and asks for nothing when moving or completing', () => {
    expect(feeChoices('noShow', 125, null).map(choice => choice.text)).toEqual(['No fee', 'Full price £125.00'])
    expect(feeChoices('reschedule', 125, 125)).toEqual([])
    expect(feeChoices('complete', 125, 0)).toEqual([])
  })
})

describe('commands sent to the server', () => {
  const calls = []
  const client = { rpc: vi.fn(async (name, args) => { calls.push([name, args]); return { data: null, error: null } }) }
  const api = createLifecycleApi(client)
  it('sends the versions the Admin saw, so a changed booking is refused', async () => {
    await api.act('cancel', booking(), 'req-1', { reason: 'Unwell', initiatedBy: 'admin', fee: 0 })
    expect(calls.at(-1)).toEqual(['admin_cancel_booking', { p_booking_id: 'b1', p_booking_updated_at: '2031-01-01T10:00:00Z', p_payment_updated_at: '2031-01-01T10:00:01Z',
      p_request_id: 'req-1', p_reason: 'Unwell', p_initiated_by: 'admin', p_fee_gbp: 0 }])
    await api.act('reschedule', booking(), 'req-2', { date: '2031-02-01', start: 720, initiatedBy: 'client' })
    expect(calls.at(-1)[0]).toBe('admin_reschedule_booking')
    expect(calls.at(-1)[1]).toMatchObject({ p_new_date: '2031-02-01', p_new_start_minutes: 720, p_initiated_by: 'client' })
    await api.act('feeWaive', booking(), 'req-3')
    expect(calls.at(-1)).toEqual(['admin_settle_late_fee', expect.objectContaining({ p_action: 'waive' })])
  })
  it('asks for "any time" only when the new time is not a usual one', async () => {
    await api.act('reschedule', booking(), 'req-4', { date: '2031-02-01', start: 1050, initiatedBy: 'admin', anyTime: true })
    expect(calls.at(-1)[1]).toMatchObject({ p_new_date: '2031-02-01', p_new_start_minutes: 1050, p_initiated_by: 'admin', p_any_time: true })
    // A usual time is the call it always was, so a screen that is live before the database is updated keeps working.
    await api.act('reschedule', booking(), 'req-5', { date: '2031-02-01', start: 720, initiatedBy: 'admin', anyTime: false })
    expect(calls.at(-1)[1]).not.toHaveProperty('p_any_time')
    await api.act('reschedule', booking(), 'req-6', { date: '2031-02-01', start: 720, initiatedBy: 'admin' })
    expect(calls.at(-1)[1]).not.toHaveProperty('p_any_time')
  })
  it('asks for all the times of a day, leaving out the booking being moved', async () => {
    const day = { working: { open: true, start: 540, end: 1260 }, booked: [], blocks: [], slots: [{ start: 1050, usual: false, clash: false }] }
    const rpc = vi.fn(async () => ({ data: day, error: null }))
    await expect(createLifecycleApi({ rpc }).times('2031-02-01', 90, 'b1')).resolves.toBe(day)
    expect(rpc).toHaveBeenCalledWith('admin_booking_times', { p_date: '2031-02-01', p_treatment_duration_minutes: 90, p_exclude_booking_id: 'b1' })
  })
  it('says plainly why a time from Show all times is refused, in the words the database wrote', async () => {
    const refusals = [
      ['PT409', 'That time overlaps another appointment, so it is not available. Choose another time.'],
      ['PT409', 'That time is in the past. Choose another time.'],
      ['22023', 'That appointment would run past midnight. Choose an earlier time.'],
      ['PT409', 'A client is in the middle of booking that day. Try again in a few minutes.'],
    ]
    for (const [code, message] of refusals) {
      const refusing = createLifecycleApi({ rpc: async () => ({ error: { code, message } }) })
      // Not "the booking changed, so it was reloaded": the dialog stays open so another time can be chosen.
      await expect(refusing.act('reschedule', booking(), 'r', { date: '2031-02-01', start: 1050, initiatedBy: 'admin', anyTime: true })).rejects.toMatchObject({ message, conflict: false })
    }
  })
  it('never shows a raw server error when the times cannot be loaded', async () => {
    const failing = createLifecycleApi({ rpc: async () => ({ error: { code: 'XX000', message: 'secret SQL detail' } }) })
    await expect(failing.times('2031-02-01', 60, 'b1')).rejects.toThrow("I couldn't load all the times just now. Please try again in a moment.")
  })
  it('never shows raw server errors, but shows the messages written for the Admin', async () => {
    const failing = createLifecycleApi({ rpc: async () => ({ error: { code: 'XX000', message: 'secret SQL detail' } }) })
    await expect(failing.act('complete', booking(), 'r')).rejects.toThrow('Could not complete the action. Refresh the booking before trying again.')
    const clash = createLifecycleApi({ rpc: async () => ({ error: { code: 'PT409', message: 'This time is not available. Choose another time.' } }) })
    await expect(clash.act('reschedule', booking(), 'r', { date: '2031-02-01', start: 600, initiatedBy: 'admin' })).rejects.toMatchObject({ message: 'This time is not available. Choose another time.', conflict: false })
    const stale = createLifecycleApi({ rpc: async () => ({ error: { code: 'PT409', message: 'Booking state changed' } }) })
    await expect(stale.act('complete', booking(), 'r')).rejects.toMatchObject({ conflict: true })
  })
})
