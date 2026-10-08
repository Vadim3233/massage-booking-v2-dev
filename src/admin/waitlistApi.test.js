import { describe, expect, it } from 'vitest'
import { TIME_WINDOWS } from '../client/booking/waitlistWindows.js'
import { createWaitlistApi, waitlistActions, windowText } from './waitlistApi.js'

describe('waitlist wording', () => {
  it('describes a preferred time of day', () => {
    expect(windowText(0, 1440)).toBe('Any time of day')
    expect(windowText(0, 720)).toBe('00:00 to 12:00')
    expect(windowText(720, 1020)).toBe('12:00 to 17:00')
    expect(windowText(1020, 1440)).toBe('17:00 to 24:00')
  })
  it('offers every time of day the client can choose, as ranges the server accepts', () => {
    for (const [, , from, to] of TIME_WINDOWS) { expect(from).toBeGreaterThanOrEqual(0); expect(to).toBeLessThanOrEqual(1440); expect(from).toBeLessThan(to) }
    expect(TIME_WINDOWS[0].slice(2)).toEqual([0, 1440])
  })
})

describe('what can be done with a request', () => {
  it('follows where the request is', () => {
    expect(waitlistActions({ status: 'active' })).toEqual(['offered', 'booked', 'not_needed'])
    expect(waitlistActions({ status: 'offered' })).toEqual(['reopen', 'booked', 'not_needed'])
    expect(waitlistActions({ status: 'closed' })).toEqual([])
  })
})

describe('commands and errors', () => {
  it('sends the action and note', async () => {
    const calls = []
    await createWaitlistApi({ rpc: async (name, args) => { calls.push([name, args]); return { data: null, error: null } } }).update('w1', 'offered', 'Offered 12:00')
    expect(calls[0]).toEqual(['admin_update_waitlist', { p_id: 'w1', p_action: 'offered', p_note: 'Offered 12:00' }])
  })
  it('keeps the kind messages and hides the rest', async () => {
    const failing = message => createWaitlistApi({ rpc: async () => ({ error: { message } }) })
    await expect(failing('This request is already closed').update('w', 'offered')).rejects.toThrow('This request is already closed')
    await expect(failing('relation "waitlist_requests" does not exist').list()).rejects.toThrow('Could not complete that.')
  })
})
