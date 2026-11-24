import { describe, expect, it, vi } from 'vitest'
import { canExtend, canRemoveExtension, createExtendApi, extraBadge, minutesWords, nextClash, owedExtraMinutes, runningLateLink, runningLateText, stayedLongerCount, suggestedPrice } from './extendApi.js'
import { lifecycleActions } from './bookingLifecycleApi.js'
import { extraOwed, needsYou } from './paymentReviewApi.js'
import { combinedReminderText, owed, owedLine, reminderDue, reminderText } from './shareBooking.js'
import { shiftDate, today } from './calendarPresentation.js'

const bank = { configured: true, sortCode: '00-11-22', accountNumber: '12345678' }
const booking = (overrides = {}) => ({ id: 'b1', updated_at: '2031-01-01T10:00:00Z', booking_status: 'confirmed', date: shiftDate(today(), -1), start_minutes: 1080,
  treatment_duration_minutes: 60, total_gbp: 90, balance_due_gbp: 0, late_fee_status: 'none', refund_due_gbp: 0, booking_reference: 'VDM-1',
  booking_payments: { method: 'bank_transfer', status: 'paid', amount_gbp: 90, payment_reference: 'VDM-1' }, booking_extensions: [], clients: { first_name: 'Sarah', phone: '07700 900123' }, ...overrides })

describe('the suggested price for extra time (Vadim: £90 an hour)', () => {
  it('is the hourly price pro rata, to the nearest £1', () => {
    expect([15, 30, 45, 60, 120].map(minutes => suggestedPrice(90, minutes))).toEqual([23, 45, 68, 90, 180])
    expect(suggestedPrice(100, 30)).toBe(50)
    expect(suggestedPrice(null, 30)).toBe(0)
  })
  it('says the length plainly', () => {
    expect([15, 60, 75, 120].map(minutesWords)).toEqual(['15 min', '1 h', '1 h 15 min', '2 h'])
    expect(extraBadge(booking({ booking_extensions: [{ minutes: 30 }, { minutes: 15 }] }))).toBe('+45 min')
    expect(extraBadge(booking())).toBe('')
  })
})

describe('when extra time can be added', () => {
  it('once the session has started, for 7 days, on a booking that went ahead', () => {
    expect(canExtend(booking())).toBe(true)
    expect(canExtend(booking({ booking_status: 'completed' }))).toBe(true)
    expect(canExtend(booking({ date: shiftDate(today(), 1) }))).toBe(false)
    expect(canExtend(booking({ date: shiftDate(today(), -8) }))).toBe(false)
    expect(canExtend(booking({ date: shiftDate(today(), -7) }))).toBe(true)
    for (const status of ['cancelled', 'no_show', 'awaiting_transfer']) expect(canExtend(booking({ booking_status: status }))).toBe(false)
    expect(canExtend(booking({ booking_payments: { status: 'refunded' } }))).toBe(false)
    expect(canExtend(booking({ booking_extensions: [{ minutes: 60 }, { minutes: 60 }] }))).toBe(false)
  })
  it('puts Add extra time first, and hides Edit booking once there is extra time', () => {
    expect(lifecycleActions(booking())[0]).toBe('extend')
    expect(lifecycleActions(booking())).toContain('edit')
    expect(lifecycleActions(booking({ booking_extensions: [{ minutes: 30 }] }))).not.toContain('edit')
    expect(lifecycleActions(booking({ date: shiftDate(today(), 3) }))).not.toContain('extend')
  })
})

describe('running into the next booking', () => {
  const preview = { end_minutes: 1140, next: { start_minutes: 1170, travel_buffer_minutes: 30, first_name: 'Tom', phone: '07700 900456' } }
  it('says whether the new end leaves time to get there', () => {
    expect(nextClash(preview, 0)).toMatchObject({ clash: false, leaveBy: 1140, late: 0 })
    expect(nextClash(preview, 30)).toMatchObject({ clash: true, ends: 1170, late: 30 })
    expect(nextClash({ end_minutes: 1140, next: null }, 30)).toBeNull()
  })
  it('offers a running-late message for the next client', () => {
    expect(runningLateText('Tom', 12)).toContain("Hi Tom, just to let you know I'm running about 15 minutes late today.")
    expect(runningLateLink(preview.next, 30)).toMatch(/^https:\/\/wa\.me\/447700900456\?text=/)
    expect(runningLateLink({ first_name: 'Tom' }, 30)).toBeNull()
  })
})

describe('an extra still to pay on a paid booking', () => {
  const extra = booking({ total_gbp: 135, balance_due_gbp: 45, booking_extensions: [{ minutes: 30, price_gbp: 45, pay_by: 'transfer' }] })
  it('goes into To check once the session is over, or once the client says they sent it', () => {
    expect(extraOwed(extra)).toBe(true)
    expect(needsYou(extra)).toBe(true)
    expect(extraOwed(booking())).toBe(false)
    expect(extraOwed({ ...extra, date: shiftDate(today(), 2) })).toBe(false)
    expect(extraOwed({ ...extra, date: shiftDate(today(), 2), balance_reported_at: '2031-01-01T10:00:00Z' })).toBe(true)
  })
  it('can be asked for on WhatsApp, for the extra only', () => {
    expect(reminderDue(extra)).toBe(true)
    expect(owed(extra)).toBe(45)
    expect(owedLine(extra)).toMatch(/18:00 · extra 30 min - £45\.00$/)
    const text = reminderText(extra, bank)
    expect(text).toContain('Hi Sarah, thank you for staying a little longer!')
    expect(text).toContain('Sort code: 00-11-22')
    expect(text).toMatch(/18:00 · extra 30 min\n💷 \*To pay: £45\.00\*\n/)
    expect(combinedReminderText([extra, booking({ id: 'b2', date: shiftDate(today(), -3), booking_payments: { method: 'bank_transfer', status: 'awaiting_transfer', amount_gbp: 90 } })], bank, 'Sarah')).toContain('💷 *Total to pay: £135.00*')
  })
})

describe('the Extend calls', () => {
  it('sends the booking version, and says the server\'s own words', async () => {
    const rpc = vi.fn(async () => ({ data: 'b1', error: null }))
    const api = createExtendApi({ rpc })
    await api.extend(booking(), 'r1', { sessionId: 's1', minutes: 30, price: 45, payBy: 'cash', notify: false })
    expect(rpc).toHaveBeenCalledWith('admin_extend_booking', { p_booking_id: 'b1', p_request_id: 'r1', p_booking_updated_at: '2031-01-01T10:00:00Z', p_session_id: 's1', p_minutes: 30, p_price_gbp: 45, p_pay_by: 'cash', p_notify: false })
    const refusing = createExtendApi({ rpc: async () => ({ data: null, error: { code: '22023', message: 'A booking can have up to 2 hours of extra time in all.' } }) })
    await expect(refusing.extend(booking(), 'r2', { sessionId: 's1', minutes: 30, price: 45, payBy: 'cash' })).rejects.toThrow('A booking can have up to 2 hours of extra time in all.')
    const stale = createExtendApi({ rpc: async () => ({ data: null, error: { code: 'PT409', message: 'Booking state changed' } }) })
    await expect(stale.remove(booking(), { id: 'e1' }, 'r3')).rejects.toMatchObject({ conflict: true })
  })
  it('counts the bookings a client stayed longer on', () => {
    expect(stayedLongerCount([{ booking_id: 'a' }, { booking_id: 'a' }, { booking_id: 'b' }])).toBe(2)
  })
})

describe('what can be undone and what is owed', () => {
  const paid = { booking_status: 'completed', balance_due_gbp: 45, booking_payments: { status: 'paid' } }
  it('keeps extra time whose money came in', () => {
    expect(canRemoveExtension(paid, { pay_by: 'cash', price_gbp: 45 })).toBe(false)
    expect(canRemoveExtension(paid, { pay_by: 'transfer', price_gbp: 45, received_at: '2026-11-15T18:00:00Z' })).toBe(false)
    expect(canRemoveExtension(paid, { pay_by: 'transfer', price_gbp: 45 })).toBe(true)
    expect(canRemoveExtension(paid, { pay_by: 'free', price_gbp: 0 })).toBe(true)
    expect(canRemoveExtension(paid, { pay_by: 'bill', price_gbp: 45 })).toBe(false)
    expect(canRemoveExtension({ ...paid, booking_payments: { status: 'awaiting_transfer' } }, { pay_by: 'bill', price_gbp: 45 })).toBe(true)
  })
  it('names only the extra time still to pay', () => {
    expect(owedExtraMinutes({ booking_extensions: [{ minutes: 30, pay_by: 'cash' }, { minutes: 15, pay_by: 'transfer' }, { minutes: 30, pay_by: 'transfer', received_at: 'x' }] })).toBe(15)
  })
  it('a booking with extra time is not a no-show, and is not edited, moved or cancelled', () => {
    const actions = lifecycleActions({ booking_status: 'confirmed', date: '2026-11-15', start_minutes: 600, booking_payments: { status: 'paid' }, booking_extensions: [{ minutes: 30, pay_by: 'free' }] })
    for (const kind of ['noShow', 'edit', 'reschedule', 'cancel']) expect(actions).not.toContain(kind)
    expect(actions).toContain('complete')
  })
})
