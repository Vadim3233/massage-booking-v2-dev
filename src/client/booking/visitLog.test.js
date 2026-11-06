import { describe, expect, it, vi } from 'vitest'
import { createVisitLog, trackingAllowed } from './visitLog.js'

describe('the visit log', () => {
  it('sends each step once, with the visit id', () => {
    const send = vi.fn(() => Promise.resolve())
    const log = createVisitLog(send, { id: 'visit-1', allowed: true })
    log.record('opened', { step: 0 })
    log.record('opened', { step: 0 })
    log.record('day', { date: '2026-11-07', free: 0 })
    expect(send.mock.calls).toEqual([['visit-1', 'opened', { step: 0 }], ['visit-1', 'day', { date: '2026-11-07', free: 0 }]])
  })

  it('never gets in the way when sending fails', () => {
    const log = createVisitLog(() => { throw new Error('offline') }, { id: 'visit-2', allowed: true })
    expect(() => log.record('opened')).not.toThrow()
    const rejecting = createVisitLog(() => Promise.reject(new Error('offline')), { id: 'visit-3', allowed: true })
    expect(() => rejecting.record('opened')).not.toThrow()
  })

  it('sends nothing for a browser that asks not to be tracked', () => {
    const send = vi.fn()
    createVisitLog(send, { id: 'visit-4', allowed: false }).record('opened')
    expect(send).not.toHaveBeenCalled()
    expect(trackingAllowed({ globalPrivacyControl: true })).toBe(false)
    expect(trackingAllowed({ doNotTrack: '1' })).toBe(false)
    expect(trackingAllowed({ doNotTrack: 'unspecified' })).toBe(true)
  })
})
