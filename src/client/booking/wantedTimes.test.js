import { describe, expect, it } from 'vitest'
import { preferenceChoices } from './wantedTimes.js'

describe('"None of these suit me" choices', () => {
  it('on a weekday offer the weekend', () => {
    expect(preferenceChoices('2026-11-09').map(([, label]) => label)).toEqual(['Early morning', 'Lunchtime', 'After work', 'Weekend instead'])
  })
  it('at the weekend offer a weekday', () => {
    expect(preferenceChoices('2026-11-07').map(([, label]) => label)).toEqual(['Morning', 'Afternoon', 'Evening', 'A weekday instead'])
    expect(preferenceChoices('2026-11-08').map(([key]) => key)).toContain('weekday')
  })
})
