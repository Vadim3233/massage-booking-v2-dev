import { describe, expect, it, vi } from 'vitest'
import { createLifecycleApi, lifecycleActions } from './bookingLifecycleApi.js'
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
  it('never shows raw server errors, but shows the messages written for the Admin', async () => {
    const failing = createLifecycleApi({ rpc: async () => ({ error: { code: 'XX000', message: 'secret SQL detail' } }) })
    await expect(failing.act('complete', booking(), 'r')).rejects.toThrow('Could not complete the action. Refresh the booking before trying again.')
    const clash = createLifecycleApi({ rpc: async () => ({ error: { code: 'PT409', message: 'This time is not available. Choose another time.' } }) })
    await expect(clash.act('reschedule', booking(), 'r', { date: '2031-02-01', start: 600, initiatedBy: 'admin' })).rejects.toMatchObject({ message: 'This time is not available. Choose another time.', conflict: false })
    const stale = createLifecycleApi({ rpc: async () => ({ error: { code: 'PT409', message: 'Booking state changed' } }) })
    await expect(stale.act('complete', booking(), 'r')).rejects.toMatchObject({ conflict: true })
  })
})
