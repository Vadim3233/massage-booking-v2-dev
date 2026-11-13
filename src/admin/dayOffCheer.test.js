import { describe, expect, it } from 'vitest'
import { CHEER_LINES, cheerLine, isDayOff } from './dayOffCheer.js'

describe('cheerLine', () => {
  it('always gives the same line for the same date', () => {
    expect(cheerLine('2026-11-14')).toBe(cheerLine('2026-11-14'))
    expect(CHEER_LINES).toContain(cheerLine('2026-11-14'))
  })

  it('gives a weekly day off a different line every week until every line has been used', () => {
    const saturdays = Array.from({ length: CHEER_LINES.length }, (_, week) => {
      const date = new Date(Date.UTC(2026, 10, 14 + week * 7))
      return cheerLine(date.toISOString().slice(0, 10))
    })
    expect(new Set(saturdays).size).toBe(CHEER_LINES.length)
  })

  it('still says something for a date it cannot read', () => {
    expect(cheerLine('not a date')).toBe(CHEER_LINES[0])
  })
})

describe('isDayOff', () => {
  it('is the usual day off and a special day off, nothing else', () => {
    expect(['closed', 'off', 'free', 'special', 'block', 'away'].map(kind => isDayOff({ kind }))).toEqual([true, true, false, false, false, false])
  })
})
