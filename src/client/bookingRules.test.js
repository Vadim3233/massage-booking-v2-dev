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
  it('keeps the payment reminder wording at the usual settings', () => {
    expect(cancellationNote(DEFAULT_RULES, false)).toBe('Free cancellation up to 24 hours before your appointment. Cancellations within 24 hours are subject to the full appointment fee.')
    expect(cancellationNote(DEFAULT_RULES, true)).toBe('Just a quick reminder: the full appointment fee applies to cancellations made within 24 hours of your appointment.')
  })
  it('follows the Admin\'s own window', () => {
    expect(cancellationNote({ ...DEFAULT_RULES, freeHours: 48 }, false)).toContain('up to 48 hours before')
    expect(cancellationNote({ ...DEFAULT_RULES, freeHours: 1 }, true)).toContain('within 1 hour of')
    expect(cancellationNote({ ...DEFAULT_RULES, freeHours: 0 }, false)).toBe('You can cancel or change your appointment at any time before it begins.')
  })
})
