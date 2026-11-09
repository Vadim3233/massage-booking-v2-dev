import { describe, expect, it } from 'vitest'
import { payAfterChoice, sessionDay, shortDay } from './payAfter.js'

describe('paying for one session at a time', () => {
  const earlier = { id: 'e1', date: '2026-11-12', start_minutes: 600, booking_status: 'confirmed' }
  it('names the day the way the booking pill does', () => {
    expect(sessionDay('2026-11-12')).toBe('Thu 12 Nov')
    expect(shortDay('2026-11-12')).toBe('12 Nov')
  })
  it('offers "nothing to pay yet" for a bank transfer when there is an earlier session', () => {
    expect(payAfterChoice({ earlier_session: earlier }, false)).toBe(earlier)
  })
  it('does not offer it for cash, a first session, an address being checked, or one already linked', () => {
    expect(payAfterChoice({ earlier_session: earlier }, true)).toBeNull()
    expect(payAfterChoice({ earlier_session: null }, false)).toBeNull()
    expect(payAfterChoice({ earlier_session: earlier, area_check: 'outside' }, false)).toBeNull()
    expect(payAfterChoice({ earlier_session: earlier, pay_after_session: earlier }, false)).toBeNull()
    expect(payAfterChoice(null, false)).toBeNull()
  })
})
