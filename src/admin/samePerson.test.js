import { describe, expect, it } from 'vitest'
import { cautions, combineNotices, holdings, kindLabel, kindsText, matchedText, movesText, profileLabel } from './samePerson.js'

describe('what combining changes about who can see what', () => {
  const profile = (kind, extra = {}) => ({ first_name: 'Olo', last_name: 'Ehe', kind, bookings: 0, addresses: 0, ...extra })
  it('tells a guest who goes that they will need to sign in', () => {
    expect(combineNotices(profile('registered'), profile('guest', { bookings: 2 }))).toEqual(['Olo Ehe will then see and change these bookings only by signing in.'])
  })
  it('says the guest\'s phone stops showing them when nobody has a login', () => {
    expect(combineNotices(profile('added'), profile('guest', { bookings: 1 }))).toEqual(["Olo Ehe's own phone or browser will then stop showing these bookings."])
  })
  it('warns when a guest\'s profile is the one that stays, because their phone can then see the other profile', () => {
    expect(combineNotices(profile('guest', { first_name: 'Gus' }), profile('added', { bookings: 1 }))).toEqual(["Gus Ehe's own phone or browser will then be able to see these bookings and addresses."])
    expect(combineNotices(profile('guest'), profile('added', { addresses: 1 }))).toHaveLength(1)
  })
  it('says both when both are guests', () => {
    expect(combineNotices(profile('guest'), profile('guest', { bookings: 1 }))).toHaveLength(2)
  })
  it('says nothing when there is nothing to see or lose', () => {
    expect(combineNotices(profile('registered'), profile('added', { bookings: 3 }))).toEqual([])
    expect(combineNotices(profile('guest'), profile('guest'))).toEqual([])
  })
})

describe('cautions before combining', () => {
  const pair = (one, two) => [{ first_name: one }, { first_name: two }]
  it('says nothing when the first names agree and an email matches', () => {
    expect(cautions(pair('Olo', ' olo '), ['email'])).toEqual([])
    expect(cautions(pair('Olo', 'OLO'), ['email', 'phone'])).toEqual([])
    expect(cautions(pair('Olo', 'Olo'), [])).toEqual([])
  })
  it('warns when the first names are different', () => {
    expect(cautions(pair('Olo', 'Jane'), ['email'])).toEqual(['The first names are different, so check that these really are the same person.'])
  })
  it('warns when only a phone number matches, because it was never checked', () => {
    const [note] = cautions(pair('Olo', 'Olo'), ['phone'])
    expect(note).toMatch(/share a phone number but not an email/)
    expect(note).toMatch(/not checked/)
  })
  it('can warn about both', () => {
    expect(cautions(pair('Olo', 'Jane'), ['phone'])).toHaveLength(2)
  })
})

describe('describing two profiles that might be one person', () => {
  it('says how a profile is signed in', () => {
    expect(kindLabel('registered')).toBe('Has a login')
    expect(kindLabel('guest')).toBe('Booked as a guest')
    expect(kindLabel('added')).toBe('Added by you')
    expect(kindLabel('unknown')).toBe('Client')
  })
  it('says how the two of a pair are signed in, without repeating itself', () => {
    expect(kindsText('registered', 'guest')).toBe('has a login and booked as a guest')
    expect(kindsText('guest', 'added')).toBe('added by you and booked as a guest')
    expect(kindsText('added', 'guest')).toBe('added by you and booked as a guest')
    expect(kindsText('guest', 'registered')).toBe('has a login and booked as a guest')
    expect(kindsText('added', 'registered')).toBe('has a login and added by you')
    expect(kindsText('guest', 'guest')).toBe('both booked as guests')
    expect(kindsText('added', 'added')).toBe('both added by you')
  })
  it('says what matched', () => {
    expect(matchedText(['email'])).toBe('email')
    expect(matchedText(['phone'])).toBe('phone number')
    expect(matchedText(['email', 'phone'])).toBe('email and phone number')
    expect(matchedText([])).toBe('email')
    expect(matchedText(undefined)).toBe('email')
  })
  it('tells two profiles with one name apart', () => {
    expect(profileLabel('Olo Ehe', 'guest')).toBe('Olo Ehe (booked as a guest)')
    expect(profileLabel('Olo Ehe', 'registered')).toBe('Olo Ehe (has a login)')
  })
})

describe('what a profile holds', () => {
  it('counts bookings and names the latest days', () => {
    expect(holdings({ bookings: 2, dates: ['2026-10-13', '2026-10-09'], notes: 1, addresses: 2, repeats: 1 })).toEqual({
      bookings: '2 bookings', days: 'Tue 13 Oct, Fri 9 Oct', more: '1 note · 2 addresses · 1 weekly repeat' })
  })
  it('is honest about an empty profile', () => {
    expect(holdings({ bookings: 0, dates: [], notes: 0, addresses: 0, repeats: 0 })).toEqual({ bookings: 'No bookings yet', days: '', more: '' })
    expect(holdings({ bookings: 1, dates: ['2026-10-09'] }).bookings).toBe('1 booking')
  })
})

describe('what the combine moved', () => {
  it('reads as a sentence', () => {
    expect(movesText({ bookings: 2, repeats: 0, notes: 1, addresses: 1, waitlist: 0 })).toBe('Moved 2 bookings, 1 note and 1 address.')
    expect(movesText({ bookings: 1, repeats: 1, notes: 3, addresses: 2, waitlist: 1 })).toBe('Moved 1 booking, 1 weekly repeat, 3 notes, 2 addresses and 1 waitlist request.')
    expect(movesText({ bookings: 1 })).toBe('Moved 1 booking.')
  })
  it('says so when there was nothing to move', () => {
    expect(movesText({ bookings: 0, notes: 0 })).toBe('Nothing needed moving.')
    expect(movesText(undefined)).toBe('Nothing needed moving.')
  })
})
