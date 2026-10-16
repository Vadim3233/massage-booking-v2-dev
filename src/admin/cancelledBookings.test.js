import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelledNote, hiddenCancelled, isListed, listedBookings, moneyToSort, readShowCancelled, SHOW_CANCELLED_KEY, writeShowCancelled } from './cancelledBookings.js'

const booking = (status, extra = {}) => ({ id: `b-${status}-${Math.random()}`, booking_status: status, refund_due_gbp: 0, late_fee_status: 'none', late_fee_due_gbp: 0, booking_payments: { status: 'paid' }, ...extra })

describe('money still to sort out on a cancelled booking', () => {
  it('is nothing for a booking that has not been cancelled, whatever it owes', () => {
    expect(moneyToSort(booking('confirmed', { refund_due_gbp: 90, late_fee_status: 'due', late_fee_due_gbp: 20 }))).toBe('')
    expect(moneyToSort(undefined)).toBe('')
  })
  it('is nothing for a cancelled booking that owes nothing', () => {
    expect(moneyToSort(booking('cancelled'))).toBe('')
    expect(moneyToSort(booking('cancelled', { booking_payments: { status: 'rejected' } }))).toBe('')
  })
  it('names a refund still to send, once the payment was received', () => {
    expect(moneyToSort(booking('cancelled', { refund_due_gbp: 90 }))).toBe('refund £90.00 to send')
    expect(moneyToSort(booking('cancelled', { refund_due_gbp: '45.5' }))).toBe('refund £45.50 to send')
  })
  it('does not name a refund that cannot be recorded, because the payment was never received', () => {
    expect(moneyToSort(booking('cancelled', { refund_due_gbp: 90, booking_payments: { status: 'awaiting_transfer' } }))).toBe('')
    expect(moneyToSort(booking('cancelled', { refund_due_gbp: 90, booking_payments: null }))).toBe('')
  })
  it('names a late fee that is still due, and stops naming it once it is received or waived', () => {
    expect(moneyToSort(booking('cancelled', { late_fee_status: 'due', late_fee_due_gbp: 20 }))).toBe('late fee £20.00 due')
    expect(moneyToSort(booking('cancelled', { late_fee_status: 'received', late_fee_due_gbp: 20 }))).toBe('')
    expect(moneyToSort(booking('cancelled', { late_fee_status: 'waived', late_fee_due_gbp: 20 }))).toBe('')
  })
  it('names both when both are owed, and stops naming a refund once it is recorded', () => {
    expect(moneyToSort(booking('cancelled', { refund_due_gbp: 65, late_fee_status: 'due', late_fee_due_gbp: 20 }))).toBe('refund £65.00 to send · late fee £20.00 due')
    expect(moneyToSort(booking('cancelled', { refund_due_gbp: 0, late_fee_status: 'due', late_fee_due_gbp: 20 }))).toBe('late fee £20.00 due')
  })
  it('reads the payment whether it comes as one record or as a list of one', () => {
    expect(moneyToSort(booking('cancelled', { refund_due_gbp: 90, booking_payments: [{ status: 'paid' }] }))).toBe('refund £90.00 to send')
  })
})

describe('which bookings the lists show', () => {
  const live = booking('confirmed')
  const waiting = booking('awaiting_transfer')
  const done = booking('completed')
  const missed = booking('no_show')
  const gone = booking('cancelled')
  const owed = booking('cancelled', { refund_due_gbp: 90 })
  const all = [live, gone, waiting, owed, done, missed]

  it('leaves out cancelled bookings by default, and keeps every other kind', () => {
    expect(listedBookings(all, false)).toEqual([live, waiting, owed, done, missed])
  })
  it('keeps a cancelled booking that still has money to sort out', () => {
    expect(isListed(owed, false)).toBe(true)
    expect(isListed(gone, false)).toBe(false)
  })
  it('lists everything, in the same order, when cancelled bookings are asked for', () => {
    expect(listedBookings(all, true)).toBe(all)
    expect(isListed(gone, true)).toBe(true)
  })
  it('counts the ones the switch is hiding, which is not the ones that stay for their money', () => {
    expect(hiddenCancelled(all)).toBe(1)
    expect(hiddenCancelled([live, owed])).toBe(0)
    expect(hiddenCancelled([gone, booking('cancelled'), live])).toBe(2)
  })
})

describe('the choice, kept on this device', () => {
  afterEach(() => vi.unstubAllGlobals())
  const storage = (initial = {}) => {
    const kept = { ...initial }
    return { getItem: key => kept[key] ?? null, setItem: (key, value) => { kept[key] = String(value) }, kept }
  }
  it('is off until it is switched on', () => {
    vi.stubGlobal('localStorage', storage())
    expect(readShowCancelled()).toBe(false)
  })
  it('is on only when it was left on', () => {
    vi.stubGlobal('localStorage', storage({ [SHOW_CANCELLED_KEY]: '1' }))
    expect(readShowCancelled()).toBe(true)
    vi.stubGlobal('localStorage', storage({ [SHOW_CANCELLED_KEY]: '0' }))
    expect(readShowCancelled()).toBe(false)
  })
  it('is remembered when it is changed', () => {
    const local = storage()
    vi.stubGlobal('localStorage', local)
    writeShowCancelled(true)
    expect(local.kept[SHOW_CANCELLED_KEY]).toBe('1')
    writeShowCancelled(false)
    expect(local.kept[SHOW_CANCELLED_KEY]).toBe('0')
  })
  it('is off, and changing it is not an error, where the phone will not keep anything', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    expect(readShowCancelled()).toBe(false)
    expect(() => writeShowCancelled(true)).not.toThrow()
  })
})

describe('who cancelled a booking and when, for its card', () => {
  const now = new Date('2026-10-16T20:00:00Z')
  const cancelled = (extra = {}) => booking('cancelled', { cancelled_at: '2026-10-14T17:20:00Z', cancelled_by_actor_type: 'client', ...extra })
  it('says who cancelled it and when, by the clock in London', () => {
    expect(cancelledNote(cancelled(), now)).toBe('by client · Wed 14 Oct, 18:20')
    expect(cancelledNote(cancelled({ cancelled_by_actor_type: 'admin', cancelled_at: '2026-10-15T08:05:00Z' }), now)).toBe('by you · Thu 15 Oct, 09:05')
    expect(cancelledNote(cancelled({ cancelled_by_actor_type: 'system' }), now)).toBe('automatically · Wed 14 Oct, 18:20')
  })
  it('gives just the day and time when nobody is named', () => {
    expect(cancelledNote(cancelled({ cancelled_by_actor_type: null }), now)).toBe('Wed 14 Oct, 18:20')
    expect(cancelledNote(cancelled({ cancelled_by_actor_type: 'someone new' }), now)).toBe('Wed 14 Oct, 18:20')
  })
  it('adds the year for an older cancellation', () => {
    expect(cancelledNote(cancelled({ cancelled_at: '2025-12-30T10:00:00Z' }), now)).toBe('by client · Tue 30 Dec 2025, 10:00')
  })
  it('is nothing for a booking that is not cancelled, or whose time was never recorded', () => {
    expect(cancelledNote(booking('confirmed', { cancelled_at: '2026-10-14T17:20:00Z' }), now)).toBe('')
    expect(cancelledNote(cancelled({ cancelled_at: null }), now)).toBe('')
    expect(cancelledNote(undefined, now)).toBe('')
  })
})
