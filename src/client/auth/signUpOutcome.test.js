import { describe, expect, it } from 'vitest'
import { signUpOutcome } from './signUpOutcome.js'

describe('what a sign-up did', () => {
  it('is signed in when a session came back', () => {
    expect(signUpOutcome({ user: { identities: [{ provider: 'email' }] }, session: { access_token: 'x' } })).toBe('signed-in')
  })

  it('needs the email confirmed when there is a new user and no session', () => {
    expect(signUpOutcome({ user: { identities: [{ provider: 'email' }] }, session: null })).toBe('confirm-email')
  })

  it('knows an email that already has an account, from the made-up user with no identities', () => {
    expect(signUpOutcome({ user: { identities: [] }, session: null })).toBe('already-registered')
  })

  it('does not call a user without an identity list "already registered"', () => {
    expect(signUpOutcome({ user: {}, session: null })).toBe('confirm-email')
    expect(signUpOutcome({ user: null, session: null })).toBe('confirm-email')
    expect(signUpOutcome(undefined)).toBe('confirm-email')
  })

  it('trusts a session over everything else', () => {
    expect(signUpOutcome({ user: { identities: [] }, session: { access_token: 'x' } })).toBe('signed-in')
  })
})
