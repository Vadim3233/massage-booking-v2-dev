import { describe, expect, it } from 'vitest'
import { addDays, clampStrip, dayParts, stripFrom } from './dateStrip.js'

describe('date strip', () => {
  it('counts days across month and year ends, and the clocks changing', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02')
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02')
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26')
    expect(addDays('2026-10-12', -12)).toBe('2026-09-30')
  })
  it('shows five consecutive days', () => {
    expect(stripFrom('2026-10-12')).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'])
    expect(stripFrom('2026-10-12', 2)).toEqual(['2026-10-12', '2026-10-13'])
  })
  it('never starts before today or runs past the last bookable day', () => {
    expect(clampStrip('2026-10-05', '2026-10-12', '2026-11-20')).toBe('2026-10-12')
    expect(clampStrip('2026-11-19', '2026-10-12', '2026-11-20')).toBe('2026-11-16')
    expect(clampStrip('2026-10-20', '2026-10-12', '2026-11-20')).toBe('2026-10-20')
    expect(clampStrip('2026-10-13', '2026-10-12', '2026-10-14')).toBe('2026-10-12')
  })
  it('names a day in London time, in the words a person would say', () => {
    expect(dayParts('2026-10-21')).toEqual({ weekday: 'Wed', day: '21', month: 'Oct', long: 'Wednesday 21 October' })
    expect(dayParts('2026-03-29').long).toBe('Sunday 29 March')
  })
})
