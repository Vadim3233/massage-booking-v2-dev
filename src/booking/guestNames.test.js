import { describe, expect, it } from 'vitest'
import { guestLabel, sessionNames, withGuestNames } from './guestNames.js'

const session = (recipient_name = '') => ({ duration_minutes: 60, recipient_name, preference_ids: [] })

describe('names for the people in a booking', () => {
  it('numbers guests from 1', () => {
    expect([0, 1, 2].map(guestLabel)).toEqual(['Guest 1', 'Guest 2', 'Guest 3'])
  })
  it('names several people Guest 1, Guest 2 and so on when nobody typed a name', () => {
    expect(sessionNames([session(), session(), session()])).toEqual(['Guest 1', 'Guest 2', 'Guest 3'])
  })
  it('keeps a name that was typed and numbers the rest by their place', () => {
    expect(sessionNames([session('  Priya  '), session(), session('Tom')])).toEqual(['Priya', 'Guest 2', 'Tom'])
  })
  it('uses the person booking for a booking for one person', () => {
    expect(sessionNames([session()], 'Amelia Hart')).toEqual(['Amelia Hart'])
    expect(sessionNames([session()])).toEqual([''])
    expect(sessionNames([session('Amelia')], 'Someone Else')).toEqual(['Amelia'])
  })
  it('returns the sessions with the names filled in and everything else untouched', () => {
    expect(withGuestNames([session(), session('Tom')], 'Ignored')).toEqual([
      { duration_minutes: 60, recipient_name: 'Guest 1', preference_ids: [] },
      { duration_minutes: 60, recipient_name: 'Tom', preference_ids: [] },
    ])
  })
})
