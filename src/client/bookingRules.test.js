import { describe, expect, it } from 'vitest'
import { cancellationNote, DEFAULT_RULES, rulesFromRow } from './bookingRules.js'

describe('booking rules shown to clients', () => {
  it('reads what the server says and falls back to the usual values for anything unusable', () => {
    expect(rulesFromRow({ booking_horizon_days: 30, minimum_notice_hours: 4, free_cancellation_hours: 48, grace_minutes: 30 }))
      .toEqual({ horizonDays: 30, noticeHours: 4, freeHours: 48, graceMinutes: 30 })
    expect(rulesFromRow(null)).toEqual(DEFAULT_RULES)
    expect(rulesFromRow({ booking_horizon_days: 'x', free_cancellation_hours: -3 })).toMatchObject({ horizonDays: 40, freeHours: 24 })
    expect(rulesFromRow({ booking_horizon_days: 0 }).horizonDays).toBe(40)
  })
  it('says the same thing for bank transfer and cash: free while there is time, then a late fee of up to the full price', () => {
    expect(cancellationNote(DEFAULT_RULES)).toBe('Free to change or cancel more than 24 hours before your appointment. After that, a late fee of up to the full appointment price may apply.')
  })
  it('follows the Admin\'s own window', () => {
    expect(cancellationNote({ ...DEFAULT_RULES, freeHours: 48 })).toContain('more than 48 hours before')
    expect(cancellationNote({ ...DEFAULT_RULES, freeHours: 1 })).toContain('more than 1 hour before')
    expect(cancellationNote({ ...DEFAULT_RULES, freeHours: 0 })).toBe('You can cancel or change your appointment at any time before it begins.')
  })
})
