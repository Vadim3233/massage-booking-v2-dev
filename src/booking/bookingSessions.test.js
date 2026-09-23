import { describe, expect, it } from 'vitest'
import { buildBookingSessionPlan } from './bookingSessions'

describe('booking session plan', () => {
  it('keeps two 60-minute sessions separate while reserving 120 treatment minutes', () => {
    const result = buildBookingSessionPlan([60, 60])

    expect(result).toEqual({
      sessionCount: 2,
      sessionDurationsMinutes: [60, 60],
      treatmentDurationMinutes: 120,
    })
  })

  it('keeps one 120-minute session distinct from two 60-minute sessions', () => {
    const result = buildBookingSessionPlan([120])

    expect(result).toEqual({
      sessionCount: 1,
      sessionDurationsMinutes: [120],
      treatmentDurationMinutes: 120,
    })
  })

  it('adds mixed consecutive sessions into one treatment block', () => {
    const result = buildBookingSessionPlan([60, 90])

    expect(result).toEqual({
      sessionCount: 2,
      sessionDurationsMinutes: [60, 90],
      treatmentDurationMinutes: 150,
    })
  })

  it('preserves session order', () => {
    const result = buildBookingSessionPlan([90, 60, 120])

    expect(result.sessionDurationsMinutes).toEqual([90, 60, 120])
    expect(result.treatmentDurationMinutes).toBe(270)
  })

  it('rejects unsupported public session durations', () => {
    expect(() => buildBookingSessionPlan([30])).toThrow(
      'Unsupported session duration'
    )
  })

  it('rejects an empty session plan', () => {
    expect(() => buildBookingSessionPlan([])).toThrow(
      'At least one session duration is required'
    )
  })
})
