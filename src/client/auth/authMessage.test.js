import { describe, expect, it } from 'vitest'
import { GENERIC } from '../booking/friendlyError.js'
import { authMessage } from './authMessage.js'

describe('what a client reads when signing in or choosing a password goes wrong', () => {
  it('puts the usual sign-in problems in plain words', () => {
    expect(authMessage({ message: 'Invalid login credentials' })).toMatch(/email and password don't match/)
    expect(authMessage({ message: 'User already registered' })).toMatch(/already an account/)
    expect(authMessage({ message: 'Email not confirmed' })).toMatch(/confirm your email first/)
    expect(authMessage({ message: 'Password should be at least 6 characters.' })).toMatch(/at least 8 characters/)
    expect(authMessage({ message: 'email rate limit exceeded' })).toMatch(/wait a minute/)
  })
  it('tells someone who reuses their old password to choose another', () => {
    expect(authMessage({ message: 'New password should be different from the old password.' })).toBe('Please choose a password that is different from your old one.')
  })
  it('keeps anything else out of sight', () => {
    expect(authMessage({ message: 'JWT expired at 2026-10-16T19:57:16Z' })).toBe(GENERIC)
    expect(authMessage(undefined)).toBe(GENERIC)
    expect(authMessage(null)).toBe(GENERIC)
  })
})
