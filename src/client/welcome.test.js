import { describe, expect, it } from 'vitest'
import { changesNote, DEFAULT_WELCOME, paragraphs, welcomeFromRow } from './welcome.js'

describe('the welcome on the booking page', () => {
  it('splits her text into paragraphs and ignores blanks', () => {
    expect(paragraphs('One.\n\n\nTwo, with a\nline break.\n\n   ')).toEqual(['One.', 'Two, with a\nline break.'])
    expect(paragraphs('')).toEqual([])
    expect(paragraphs(null)).toEqual([])
  })
  it('reads only text from the server', () => {
    expect(welcomeFromRow({ welcome: '  Hi  ', about: 5 })).toEqual({ welcome: 'Hi', about: '' })
    expect(welcomeFromRow(null)).toEqual({ welcome: '', about: '' })
  })
  it('has a standard welcome that makes no claims about qualifications', () => {
    expect(DEFAULT_WELCOME).toMatch(/I come to you/)
    expect(DEFAULT_WELCOME).not.toMatch(/qualified|certified|insured|years/i)
  })
  it('says the free window in her own number of hours', () => {
    expect(changesNote({ freeHours: 24 })).toBe('Free to change or cancel more than 24 hours before your appointment.')
    expect(changesNote({ freeHours: 1 })).toBe('Free to change or cancel more than 1 hour before your appointment.')
    expect(changesNote({ freeHours: 48 })).toContain('48 hours')
    expect(changesNote({ freeHours: 0 })).toBe('You can change or cancel your appointment any time before it begins.')
  })
})
