import { describe, expect, it } from 'vitest'
import { londonMoment } from './londonMoment.js'

const now = new Date('2026-10-16T20:00:00Z')

describe('a moment as the clock in London shows it', () => {
  it('shows summer time one hour ahead of UTC, and winter time on UTC', () => {
    expect(londonMoment('2026-10-14T17:20:00Z', { now })).toEqual({ day: 'Wed 14 Oct', time: '18:20' })
    expect(londonMoment('2026-12-01T09:05:00Z', { now })).toEqual({ day: 'Tue 1 Dec', time: '09:05' })
  })

  it('takes the day from the London clock, not from UTC', () => {
    // 23:30 UTC on 14 October is 00:30 on the 15th in London.
    expect(londonMoment('2026-10-14T23:30:00Z', { now })).toEqual({ day: 'Thu 15 Oct', time: '00:30' })
  })

  it('writes the day out in full when asked', () => {
    expect(londonMoment('2026-10-16T15:40:00Z', { now, long: true })).toEqual({ day: 'Friday 16 October', time: '16:40' })
  })

  it('adds the year only when it is not this year', () => {
    expect(londonMoment('2025-12-30T10:00:00Z', { now })).toEqual({ day: 'Tue 30 Dec 2025', time: '10:00' })
    expect(londonMoment('2027-01-05T10:00:00Z', { now, long: true })).toEqual({ day: 'Tuesday 5 January 2027', time: '10:00' })
    expect(londonMoment('2026-01-01T00:05:00Z', { now })).toEqual({ day: 'Thu 1 Jan', time: '00:05' })
  })

  it('is nothing for a value that is not a moment', () => {
    for (const value of [null, undefined, '', 'not a date']) expect(londonMoment(value, { now })).toBeNull()
  })
})
