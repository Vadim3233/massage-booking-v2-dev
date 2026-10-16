import { describe, expect, it } from 'vitest'
import { cancelledOn } from './cancelledOn.js'

const now = new Date('2026-10-16T20:00:00Z')

describe('the line that says when a booking was cancelled', () => {
  it('gives the day and the London time', () => {
    expect(cancelledOn('2026-10-16T15:40:00Z', now)).toBe('Cancelled on Friday 16 October at 16:40.')
    expect(cancelledOn('2026-12-01T09:05:00Z', now)).toBe('Cancelled on Tuesday 1 December at 09:05.')
  })

  it('adds the year when it was not this year', () => {
    expect(cancelledOn('2025-12-30T10:00:00Z', now)).toBe('Cancelled on Tuesday 30 December 2025 at 10:00.')
  })

  it('says nothing when the time was never recorded', () => {
    expect(cancelledOn(null, now)).toBe('')
    expect(cancelledOn(undefined, now)).toBe('')
    expect(cancelledOn('', now)).toBe('')
  })
})
