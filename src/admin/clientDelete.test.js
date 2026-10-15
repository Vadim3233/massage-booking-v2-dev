import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { deleteQuestion, deleteScope, deletedMessage, whatWouldGo, whyNotDelete } from './clientDelete.js'
import { SAFE_MESSAGES } from './clientsApi.js'

const none = { addresses: 0, notes: 0, waitlist: 0, login: 'added' }

describe('what deleting a client would remove', () => {
  it('always names their details, and nothing that is not there', () => {
    expect(whatWouldGo(none)).toBe('Their details')
    expect(whatWouldGo({ ...none, login: 'guest' })).toBe('Their details')
  })
  it('counts addresses, notes and waiting-list requests, one or many', () => {
    expect(whatWouldGo({ ...none, addresses: 1 })).toBe('Their details and 1 saved address')
    expect(whatWouldGo({ ...none, addresses: 2, notes: 1 })).toBe('Their details, 2 saved addresses and 1 note')
    expect(whatWouldGo({ ...none, addresses: 2, notes: 3, waitlist: 1 })).toBe('Their details, 2 saved addresses, 3 notes and 1 waiting-list request')
  })
  it('mentions the online account only when they have a real login', () => {
    expect(whatWouldGo({ ...none, login: 'registered' })).toBe('Their details and their online account')
    expect(whatWouldGo({ ...none, notes: 2, login: 'registered' })).toBe('Their details, 2 notes and their online account')
  })
})

describe('the question before deleting', () => {
  it('names the client, says what goes and that it cannot be undone', () => {
    expect(deleteQuestion('Hugo Pell', { ...none, addresses: 2, notes: 2 })).toBe("Delete Hugo Pell? Their details, 2 saved addresses and 2 notes will be removed for good. This can't be undone.")
  })
  it("never guesses anyone's pronouns", () => {
    const text = [deleteQuestion('Sam', { ...none, notes: 1, login: 'registered' }), ...['bookings', 'repeats', 'booking_now', 'admin', 'other'].map(reason => whyNotDelete('Sam', { reason, bookings: 2 }))].join(' ')
    expect(text).not.toMatch(/\b(he|she|him|her|his|hers|himself|herself)\b/i)
  })
})

describe('what the deletion carries back to the database', () => {
  it('is what the question said would go, and nothing else', () => {
    const check = { found: true, can_delete: true, reason: null, bookings: 0, repeats: 0, addresses: 2, notes: 1, waitlist: 3, login: 'registered' }
    expect(deleteScope(check)).toEqual({ addresses: 2, notes: 1, waitlist: 3, login: 'registered' })
  })
})

describe('why a client cannot be deleted', () => {
  it('explains that bookings are her records, and points to switching off online booking', () => {
    const text = whyNotDelete('Bea Booked', { reason: 'bookings', bookings: 3 })
    expect(text).toContain('Bea Booked has 3 bookings, so they can\'t be deleted.')
    expect(text).toContain('Bookings, payments and receipts are your records, so they stay.')
    expect(text).toContain('switch off online booking')
    expect(whyNotDelete('Bea Booked', { reason: 'bookings', bookings: 1 })).toContain('has 1 booking, so')
  })
  it('says the other reasons plainly', () => {
    expect(whyNotDelete('Rae', { reason: 'repeats' })).toBe("Rae has a repeating booking, so they can't be deleted.")
    expect(whyNotDelete('Holly', { reason: 'booking_now' })).toBe('Someone is in the middle of booking right now, so nobody can be deleted for a few minutes. Try again soon.')
    expect(whyNotDelete('Ada', { reason: 'admin' })).toBe("Ada is signed in as an Admin, so they can't be deleted here.")
  })
  it('has a safe answer for a reason it does not know', () => {
    expect(whyNotDelete('Sam', { reason: 'something-new' })).toBe("Sam can't be deleted right now.")
  })
})

describe('after deleting', () => {
  it('says who was deleted', () => {
    expect(deletedMessage('Hugo Pell')).toBe('Hugo Pell was deleted.')
  })
})

// Every plain sentence the delete commands raise for the Admin has to be on the list the screen is allowed to show, otherwise she would
// see "Could not complete that" instead of what is wrong. This reads the migration and compares.
const sql = readFileSync(new URL('../../supabase/migrations/20261025100000_admin_delete_client.sql', import.meta.url), 'utf8')
const raised = [...sql.matchAll(/raise exception '([^'%]+)' using errcode = '[A-Z0-9]+'/g)].map(match => match[1])
// Never shown as they are: not the Admin, a missing field, a repeated key, a command still running.
const NEVER_SHOWN = ['Admin authorization required', 'Choose a client', 'Say what is being deleted', 'Request key reused', 'Command in progress']
const plain = [...new Set(raised.filter(message => !NEVER_SHOWN.includes(message)))]

describe('the messages the delete commands raise', () => {
  it('were found (so the checks below mean something)', () => {
    expect(new Set(raised).size).toBe(11)
    expect(plain).toHaveLength(6)
  })
  it('can all be shown to the Admin as they are, except the ones that must never be', () => {
    expect(plain.filter(message => !SAFE_MESSAGES.has(message))).toEqual([])
    expect(NEVER_SHOWN.filter(message => SAFE_MESSAGES.has(message))).toEqual([])
  })
  it('are all that the screen\'s list holds about deleting (no stale or misspelt sentence)', () => {
    const aboutDeleting = [...SAFE_MESSAGES].filter(message => /deleted|booking right now|Something changed while you were deciding|no longer there/.test(message))
    expect(aboutDeleting.filter(message => !plain.includes(message) && message !== 'One of these clients is no longer there. They may already have been combined.')).toEqual([])
  })
})
