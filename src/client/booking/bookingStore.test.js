import { describe, expect, it, vi } from 'vitest'
import { createBookingStore } from './bookingStore.js'
import { activeHold, allowedStep, browserClientKey, draftKey, durationOf, londonDate, newDraft, newSession, restoreDraft } from './bookingDraft.js'
import { finalizeParams, quoteParams } from './bookingApi.js'
import { paymentConfig } from './paymentConfig.js'

const memory = () => { const data = new Map(); return { getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value) } }
const quote = { total_gbp: 180, service_subtotal_gbp: 170, enhancements_total_gbp: 10, travel_fee_gbp: 0, congestion_fee_gbp: 0 }
function fixture() {
  const storage = memory()
  const draft = { ...newDraft(), areaId: 'area', serviceId: 'service', date: '2026-10-01', start: 600,
    sessions: [newSession(60), newSession(60)], enhancementIds: ['extra'],
    hold: { hold_id: 'hold', hold_token: 'token', expires_at: '2026-10-01T10:10:00Z' } }
  storage.setItem(draftKey, JSON.stringify({ version: 1, draft }))
  const api = { release: vi.fn().mockResolvedValue({ released: true }), hold: vi.fn().mockResolvedValue(draft.hold),
    quote: vi.fn().mockResolvedValue(quote), finalize: vi.fn().mockResolvedValue({ booking_id: 'booking', booking_reference: 'REF', payment_status: 'awaiting_verification' }) }
  const options = { api, storage, clientKey: 'opaque-key', uuid: () => 'request-1', now: () => Date.parse('2026-10-01T10:00:00Z') }
  return { ...options, store: createBookingStore(options), draft }
}

describe('booking draft and adapters', () => {
  it('persists and reuses an opaque browser key', () => {
    const storage = memory(); const uuid = vi.fn(() => '00000000-0000-4000-8000-000000000001')
    expect(browserClientKey(storage, uuid)).toBe(browserClientKey(storage, uuid)); expect(uuid).toHaveBeenCalledTimes(1)
  })
  it('recovers safely from corrupt temporary storage', () => {
    expect(restoreDraft({ getItem: () => '{broken' })).toEqual(newDraft())
  })
  it('keeps two 60-minute sessions distinct in the real RPC payload', () => {
    const { draft } = fixture(); expect(durationOf(draft)).toBe(120)
    expect(quoteParams(draft).p_sessions.map((session) => session.duration_minutes)).toEqual([60, 60])
    const params = finalizeParams(draft, 'key', 'request')
    expect(params.p_enhancement_ids).toEqual(['extra']); expect(params.p_hold_token).toBe('token')
    expect(params).not.toHaveProperty('p_total_gbp'); expect(params).not.toHaveProperty('p_client_id')
  })
  it('guards browser forward navigation and expired holds', () => {
    const { draft, now } = fixture()
    expect(allowedStep(newDraft(), 7, now())).toBe(0)
    expect(allowedStep(draft, 7, now())).toBe(5)
    expect(allowedStep(draft, 7, now() + 600001)).toBe(3)
    expect(activeHold(draft, now() + 600000)).toBe(false)
  })
  it('uses London calendar dates across DST', () => {
    expect(londonDate(0, new Date('2026-09-27T23:30:00Z'))).toBe('2026-09-28')
    expect(londonDate(40, new Date('2026-09-27T23:30:00Z'))).toBe('2026-11-07')
  })
  it('does not invent missing bank details', () => { expect(paymentConfig({}).configured).toBe(false) })
})

describe('booking state transitions', () => {
  it('releases the obsolete hold before changing dates and preserves details', async () => {
    const { store, api } = fixture(); store.edit({ note: 'Keep this' })
    await store.changeSelection({ date: '2026-10-02' })
    expect(api.release).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().draft).toMatchObject({ date: '2026-10-02', hold: null, start: null, note: 'Keep this' })
  })
  it('preserves old selection if release fails', async () => {
    const { store, api } = fixture(); api.release.mockRejectedValue(new Error('Release failed'))
    await store.changeSelection({ date: '2026-10-02' })
    expect(store.getSnapshot().draft.date).toBe('2026-10-01'); expect(store.getSnapshot().error).toBe('Release failed')
  })
  it('lets the server atomically replace a slot and prevents overlapping clicks', async () => {
    const { store, api } = fixture(); await Promise.all([store.selectSlot(660), store.selectSlot(720)])
    expect(api.hold).toHaveBeenCalledTimes(1); expect(api.release).not.toHaveBeenCalled()
    expect(store.getSnapshot().draft.start).toBe(660)
  })
  it('invalidates quotes on enhancement changes but not contact edits', async () => {
    const { store } = fixture(); await store.loadQuote(); store.edit({ note: 'hello' })
    expect(store.getSnapshot().quote).toEqual(quote)
    store.edit({ enhancementIds: [] }); expect(store.getSnapshot().quote).toBeNull()
  })
  it('requires fresh price review when the price changes', async () => {
    const { store, api } = fixture(); await store.loadQuote(); api.quote.mockResolvedValue({ ...quote, total_gbp: 190 })
    await store.finalize(); expect(api.finalize).not.toHaveBeenCalled(); expect(store.getSnapshot().error).toContain('refreshed price')
  })
  it('shows no confirmation on a database failure and allows correction', async () => {
    const { store, api } = fixture(); await store.loadQuote()
    api.finalize.mockRejectedValue({ code: '23P01', message: 'Time slot is no longer available' })
    await store.finalize()
    expect(store.getSnapshot()).toMatchObject({ result: null, error: 'Time slot is no longer available' })
    expect(store.getSnapshot().draft).toMatchObject({ bookingId: null, pending: null })
  })
  it('persists ambiguous attempts and retries exactly the same payload after reload', async () => {
    const { store, api, storage, clientKey, uuid, now } = fixture(); await store.loadQuote()
    api.finalize.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await store.finalize(); const pending = store.getSnapshot().draft.pending
    store.edit({ note: 'changed' }); expect(store.getSnapshot().draft.note).toBe('')
    const reloaded = createBookingStore({ api, storage, clientKey, uuid, now })
    expect(reloaded.getSnapshot().step).toBe(6)
    await reloaded.finalize()
    expect(api.finalize.mock.calls[1][0]).toEqual(pending)
    expect(reloaded.getSnapshot()).toMatchObject({ step: 7, result: { payment_status: 'awaiting_verification' } })
  })
  it('cannot finalize an expired hold', async () => {
    const { store, api } = fixture(); store.edit({ hold: { expires_at: '2000-01-01' } }); await store.finalize()
    expect(api.finalize).not.toHaveBeenCalled(); expect(store.getSnapshot().error).toContain('expired')
  })
  it('does not write if durable attempt storage fails', async () => {
    const { store, api, storage } = fixture(); await store.loadQuote()
    storage.setItem = () => { throw new Error('Storage unavailable') }
    await store.finalize(); expect(api.finalize).not.toHaveBeenCalled()
  })
  it('does not replay a request under a different authenticated account', async () => {
    const { store, api } = fixture(); store.edit({ ownerUserId: 'original-user' }); await store.loadQuote()
    await store.finalize('other-user'); expect(api.finalize).not.toHaveBeenCalled()
    expect(store.getSnapshot().error).toContain('account used')
  })
})
