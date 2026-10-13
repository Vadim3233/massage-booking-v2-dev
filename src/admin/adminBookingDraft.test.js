import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyAdminDraft, loadAdminDraft, saveAdminDraft } from './adminBookingDraft.js'

const store = new Map()
beforeEach(() => {
  store.clear()
  globalThis.sessionStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) }
})
afterEach(() => { delete globalThis.sessionStorage })

const draft = patch => ({ ...emptyAdminDraft('2026-10-19'), areaId: 'a1', serviceId: 's1', start: 990, ...patch })

describe('a New booking draft kept across a reload', () => {
  it('comes back as it was', () => {
    saveAdminDraft('owner', draft({ note: 'Bring the table' }))
    expect(loadAdminDraft('owner', '2026-10-19')).toMatchObject({ start: 990, note: 'Bring the table', anyTime: false })
  })
  it('forgets an unusual time, and the reasons written for it, so it is chosen again against the diary as it is now', () => {
    saveAdminDraft('owner', draft({ start: 960, anyTime: true, anyTimeNotes: ['Only 30 minutes after the 14:30 appointment ends (your usual gap is 60 minutes).'] }))
    expect(loadAdminDraft('owner', '2026-10-19')).toMatchObject({ start: null, anyTime: false, anyTimeNotes: [], areaId: 'a1', serviceId: 's1' })
  })
  it('keeps it when a booking is already being made, which has its own request', () => {
    const submission = { id: 'request-1', payload: { start_minutes: 960, any_time: true }, repeat: null }
    saveAdminDraft('owner', draft({ start: 960, anyTime: true, anyTimeNotes: ['x'], submission }))
    expect(loadAdminDraft('owner', '2026-10-19')).toMatchObject({ start: 960, anyTime: true, submission })
  })
  it('fills in what an older draft did not have', () => {
    const { anyTime, anyTimeNotes, ...older } = draft()
    store.set('admin-new-booking:v1:owner', JSON.stringify({ version: 1, draft: older }))
    expect(anyTime).toBe(false)
    expect(anyTimeNotes).toEqual([])
    expect(loadAdminDraft('owner', '2026-10-19')).toMatchObject({ start: 990, anyTime: false, anyTimeNotes: [] })
  })
})
