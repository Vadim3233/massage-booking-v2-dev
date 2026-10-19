import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyAdminDraft, forgetDraftFor, loadAdminDraft, saveAdminDraft } from './adminBookingDraft.js'
import { shiftDate, today } from './calendarPresentation.js'

// A day still to come, whatever day the tests run on (a fixed date would turn into a day that has gone).
const DAY = shiftDate(today(), 10)

const store = new Map()
beforeEach(() => {
  store.clear()
  globalThis.sessionStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) }
})
afterEach(() => { delete globalThis.sessionStorage })

const draft = patch => ({ ...emptyAdminDraft(DAY), areaId: 'a1', serviceId: 's1', start: 990, ...patch })

describe('a New booking draft kept across a reload', () => {
  it('comes back as it was', () => {
    saveAdminDraft('owner', draft({ note: 'Bring the table' }))
    expect(loadAdminDraft('owner', DAY)).toMatchObject({ start: 990, note: 'Bring the table', anyTime: false })
  })
  it('forgets an unusual time, and the reasons written for it, so it is chosen again against the diary as it is now', () => {
    saveAdminDraft('owner', draft({ start: 960, anyTime: true, anyTimeNotes: ['Only 30 minutes after the 14:30 appointment ends (your usual gap is 60 minutes).'] }))
    expect(loadAdminDraft('owner', DAY)).toMatchObject({ start: null, anyTime: false, anyTimeNotes: [], areaId: 'a1', serviceId: 's1' })
  })
  it('keeps it when a booking is already being made, which has its own request', () => {
    const submission = { id: 'request-1', payload: { start_minutes: 960, any_time: true }, repeat: null }
    saveAdminDraft('owner', draft({ start: 960, anyTime: true, anyTimeNotes: ['x'], submission }))
    expect(loadAdminDraft('owner', DAY)).toMatchObject({ start: 960, anyTime: true, submission })
  })
  it('drops a client who has just been deleted, and keeps a draft that was for anyone else', () => {
    saveAdminDraft('owner', draft({ client: { id: 'c-deleted', first_name: 'Hugo' } }))
    forgetDraftFor('owner', 'c-other')
    expect(loadAdminDraft('owner', '2026-10-19').client).toMatchObject({ id: 'c-deleted' })
    forgetDraftFor('owner', 'c-deleted')
    expect(loadAdminDraft('owner', '2026-10-19').client).toBeNull()
    expect(store.size).toBe(0)
  })
  it('only forgets for the owner whose draft it is, and does nothing when there is nothing to forget', () => {
    saveAdminDraft('owner', draft({ client: { id: 'c-deleted' } }))
    forgetDraftFor('someone-else', 'c-deleted')
    expect(store.size).toBe(1)
    forgetDraftFor('owner', undefined)
    expect(store.size).toBe(1)
    store.set('admin-new-booking:v1:broken', 'not json at all')
    expect(() => forgetDraftFor('broken', 'c-deleted')).not.toThrow()
    store.clear()
    expect(() => forgetDraftFor('owner', 'c-deleted')).not.toThrow()
  })
  it('fills in what an older draft did not have', () => {
    const { anyTime, anyTimeNotes, ...older } = draft()
    store.set('admin-new-booking:v1:owner', JSON.stringify({ version: 1, draft: older }))
    expect(anyTime).toBe(false)
    expect(anyTimeNotes).toEqual([])
    expect(loadAdminDraft('owner', DAY)).toMatchObject({ start: 990, anyTime: false, anyTimeNotes: [] })
  })
})

describe('a New booking draft and a day that has gone', () => {
  const yesterday = shiftDate(today(), -1)
  it('starts as "already happened" only when it is started from a day that has gone', () => {
    expect(emptyAdminDraft(yesterday)).toMatchObject({ past: true, date: yesterday, start: null })
    expect(emptyAdminDraft(shiftDate(today(), -300))).toMatchObject({ past: true })
    expect(emptyAdminDraft(today())).toMatchObject({ past: false, date: today() })
    expect(emptyAdminDraft(shiftDate(today(), 3))).toMatchObject({ past: false })
    expect(emptyAdminDraft()).toMatchObject({ past: false, date: today() })
  })
  it('keeps "already happened", its day, time and payment across a reload', () => {
    saveAdminDraft('owner', { ...emptyAdminDraft(yesterday), areaId: 'a1', serviceId: 's1', start: 600, payment: 'bank_received' })
    expect(loadAdminDraft('owner', today())).toMatchObject({ past: true, date: yesterday, start: 600, payment: 'bank_received' })
  })
  it('does not turn "already happened" on for an older draft that never had it', () => {
    const { past, ...older } = { ...emptyAdminDraft(today()), areaId: 'a1', serviceId: 's1', start: 990 }
    store.set('admin-new-booking:v1:owner', JSON.stringify({ version: 1, draft: older }))
    expect(past).toBe(false)
    expect(loadAdminDraft('owner', today())).toMatchObject({ past: false, start: 990 })
  })
  it('gives an older draft the choice that matches its own day, not the day New booking was opened from', () => {
    // A draft for a day still to come, kept from before the box existed, and New booking opened from a day that has gone: not ticked.
    const forTheFuture = { ...emptyAdminDraft(DAY), areaId: 'a1', serviceId: 's1', start: 990 }
    delete forTheFuture.past
    store.set('admin-new-booking:v1:owner', JSON.stringify({ version: 1, draft: forTheFuture }))
    expect(loadAdminDraft('owner', yesterday)).toMatchObject({ past: false, date: DAY, start: 990 })
    // An old draft whose day has since gone is ticked, with its own day, so the box and the day agree.
    const forAGoneDay = { ...emptyAdminDraft(yesterday), areaId: 'a1', serviceId: 's1', start: 600 }
    delete forAGoneDay.past
    store.set('admin-new-booking:v1:owner', JSON.stringify({ version: 1, draft: forAGoneDay }))
    expect(loadAdminDraft('owner', DAY)).toMatchObject({ past: true, date: yesterday, start: 600 })
  })
  it('never keeps a repeat switched on for something that has already happened: it comes back as a single appointment', () => {
    // An older draft for a day that has since gone, left with a weekly repeat on, and a newer one saved with the box ticked.
    const older = { ...emptyAdminDraft(yesterday), areaId: 'a1', serviceId: 's1', start: 600, repeat: { on: true, endDate: '2027-01-01' } }
    delete older.past
    store.set('admin-new-booking:v1:owner', JSON.stringify({ version: 1, draft: older }))
    expect(loadAdminDraft('owner', DAY)).toMatchObject({ past: true, start: 600, repeat: { on: false, endDate: '2027-01-01' } })
    saveAdminDraft('owner', { ...emptyAdminDraft(yesterday), areaId: 'a1', serviceId: 's1', start: 600, repeat: { on: true, endDate: '' } })
    expect(loadAdminDraft('owner', today())).toMatchObject({ past: true, repeat: { on: false } })
    // A repeat for the future is left alone.
    saveAdminDraft('owner', { ...emptyAdminDraft(DAY), areaId: 'a1', serviceId: 's1', start: 600, repeat: { on: true, endDate: '' } })
    expect(loadAdminDraft('owner', today())).toMatchObject({ past: false, repeat: { on: true } })
  })
  it('starts a repeat as every week, and brings a draft kept from before the other ways to repeat back as that', () => {
    expect(emptyAdminDraft(DAY).repeat).toEqual({ on: false, kind: 'weeks', every: 1, dates: [], endDate: '' })
    saveAdminDraft('owner', { ...emptyAdminDraft(DAY), areaId: 'a1', serviceId: 's1', start: 600, repeat: { on: true, endDate: '2027-01-01' } })
    expect(loadAdminDraft('owner', DAY).repeat).toEqual({ on: true, kind: 'weeks', every: 1, dates: [], endDate: '2027-01-01' })
    const chosen = { on: true, kind: 'dates', every: 1, dates: [shiftDate(DAY, 7), shiftDate(DAY, 21)], endDate: '' }
    saveAdminDraft('owner', { ...emptyAdminDraft(DAY), areaId: 'a1', serviceId: 's1', start: 600, repeat: chosen })
    expect(loadAdminDraft('owner', DAY).repeat).toEqual(chosen)
  })
  it('keeps a saved choice as it is, whatever day New booking is opened from', () => {
    saveAdminDraft('owner', { ...emptyAdminDraft(DAY), areaId: 'a1', serviceId: 's1', past: false, start: 990 })
    expect(loadAdminDraft('owner', yesterday)).toMatchObject({ past: false, date: DAY })
  })
  it('does not bring back a half-made draft with nothing in it worth keeping: New booking starts from the day it was opened from', () => {
    // She opened New booking from yesterday (so "already happened" was ticked), touched a time, and left without choosing anyone or anything.
    saveAdminDraft('owner', { ...emptyAdminDraft(yesterday), start: 600, payment: 'bank_received' })
    expect(loadAdminDraft('owner', today())).toMatchObject({ past: false, date: today(), start: null, payment: 'bank_pending' })
    expect(loadAdminDraft('owner', DAY)).toMatchObject({ past: false, date: DAY, start: null })
    // The same goes for a day picked and nothing else, for the usual kind of booking.
    saveAdminDraft('owner', { ...emptyAdminDraft(DAY), start: 990 })
    expect(loadAdminDraft('owner', today())).toMatchObject({ date: today(), start: null })
    // As soon as there is a client, a treatment, an area, an address or a note, it is kept.
    for (const kept of [{ client: { id: 'c1' } }, { serviceId: 's1' }, { areaId: 'a1' }, { note: 'Bring the table' }]) {
      saveAdminDraft('owner', { ...emptyAdminDraft(yesterday), start: 600, ...kept })
      expect(loadAdminDraft('owner', today())).toMatchObject({ past: true, date: yesterday, start: 600 })
    }
  })
})
