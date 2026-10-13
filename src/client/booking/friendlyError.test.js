import { describe, expect, it } from 'vitest'
import { friendlyError, GENERIC } from './friendlyError.js'

describe('what a client is allowed to read', () => {
  it('says a taken time in a kind sentence, however the database words it', () => {
    for (const message of ['Time slot is no longer available', 'Requested time is no longer available', 'Booking unavailable']) {
      expect(friendlyError(new Error(message))).toMatch(/^Sorry, that time has just been taken/)
    }
  })
  it('turns a lost or invalid hold into "your time was released"', () => {
    expect(friendlyError(new Error('Booking hold token is invalid'))).toBe('Your time was released. Please choose a time again.')
    expect(friendlyError(new Error('Booking hold identity is invalid or no longer active'))).toMatch(/released/)
  })
  it('keeps the sentences the server wrote for clients, which tell them what to do', () => {
    expect(friendlyError(new Error('Online appointments need at least 2 hours notice. Please choose a later time.'))).toBe('Online appointments need at least 2 hours notice. Please choose a later time.')
    expect(friendlyError(Object.assign(new Error('That phone number does not look right.'), { code: '22023' }))).toBe('That phone number does not look right.')
  })
  it('never shows a connection or system message', () => {
    for (const message of ['TypeError: Failed to fetch', 'duplicate key value violates unique constraint "bookings_pkey"', 'Missing command arguments', 'JWT expired', 'Request key reused']) {
      const shown = friendlyError(new Error(message))
      expect(shown).not.toContain(message)
      expect(shown.length).toBeGreaterThan(20)
    }
    expect(friendlyError(new Error('Missing command arguments'))).toBe(GENERIC)
  })
  it('uses the fallback when there is no message, and accepts plain text', () => {
    expect(friendlyError(undefined)).toBe(GENERIC)
    expect(friendlyError({}, 'Try again')).toBe('Try again')
    expect(friendlyError('Please choose a date.')).toBe('Please choose a date.')
  })
})
