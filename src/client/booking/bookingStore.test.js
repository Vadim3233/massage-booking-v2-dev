import { describe, expect, it, vi } from 'vitest'
import { createBookingStore } from './bookingStore.js'
import { activeHold, allowedStep, browserClientKey, draftKey, durationOf, londonDate, newDraft, newSession, restoreDraft } from './bookingDraft.js'
import { finalizeParams, quoteParams } from './bookingApi.js'
import { paymentConfig } from './paymentConfig.js'
import { GENERIC } from './friendlyError.js'

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
    expect(store.getSnapshot().draft.date).toBe('2026-10-01'); expect(store.getSnapshot().error).toBe(GENERIC)
  })
  it('lets the server atomically replace a slot and prevents overlapping clicks', async () => {
    const { store, api } = fixture(); await Promise.all([store.selectSlot(660), store.selectSlot(720)])
    expect(api.hold).toHaveBeenCalledTimes(1); expect(api.release).not.toHaveBeenCalled()
    expect(store.getSnapshot().draft.start).toBe(660)
  })
  it('saves the day with the time, and leaves a held time alone while other days are only looked at', async () => {
    const { store, api } = fixture()
    expect(store.getSnapshot().draft.hold).toMatchObject({ hold_id: 'hold' })
    expect(api.hold).not.toHaveBeenCalled(); expect(api.release).not.toHaveBeenCalled()
    api.hold.mockResolvedValue({ hold_id: 'hold-2', hold_token: 'token-2', expires_at: '2026-10-01T10:20:00Z' })
    await store.selectSlot(660, '2026-10-05')
    expect(api.hold).toHaveBeenCalledWith('2026-10-05', 660, 120, 'opaque-key')
    expect(store.getSnapshot().draft).toMatchObject({ date: '2026-10-05', start: 660, hold: { hold_id: 'hold-2' } })
  })
  it('updates the price without locking the screen, and drops a price for choices that have changed', async () => {
    const { store, api } = fixture()
    let answer
    api.quote.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const pending = store.refreshQuote()
    expect(store.getSnapshot().busy).toBe(false)
    store.edit({ enhancementIds: [] })
    answer({ ...quote, total_gbp: 999 }); await pending
    expect(store.getSnapshot().quote).toBeNull()
    await store.refreshQuote()
    expect(store.getSnapshot().quote).toEqual(quote)
  })
  it('asks the server once for the same choices, and says in plain words when the price cannot be updated', async () => {
    const { store, api } = fixture()
    await Promise.all([store.refreshQuote(), store.refreshQuote()])
    expect(api.quote).toHaveBeenCalledTimes(1)
    api.quote.mockRejectedValue(new Error('connection to server at 10.0.0.1 failed'))
    store.edit({ enhancementIds: [] })
    await store.refreshQuote()
    expect(store.getSnapshot().quoteError).toBe("I couldn't update the price just now.")
    expect(JSON.stringify(store.getSnapshot())).not.toContain('10.0.0.1')
    store.edit({ enhancementIds: ['extra'] })
    expect(store.getSnapshot().quoteError).toBe('')
  })
  it('keeps the price when only a name or a preference changes, since neither changes it', async () => {
    const { store } = fixture(); await store.loadQuote()
    store.edit({ sessions: store.getSnapshot().draft.sessions.map((session, index) => ({ ...session, recipient_name: `Guest ${index + 1}`, preference_ids: ['firm'] })) })
    expect(store.getSnapshot().quote).toEqual(quote)
    store.edit({ sessions: [newSession(60), newSession(90)] }); expect(store.getSnapshot().quote).toBeNull()
  })
  it('tries the price again from a clean slate, without showing a technical message', async () => {
    const { store, api } = fixture()
    api.quote.mockRejectedValueOnce(new Error('connection to server at 10.0.0.1 failed'))
    await store.refreshQuote()
    expect(store.getSnapshot().quoteError).not.toBe('')
    await store.retryQuote()
    expect(store.getSnapshot()).toMatchObject({ quote, quoteError: '', error: '' })
  })
  it('never lets a technical error reach the screen', async () => {
    const { store, api } = fixture()
    api.release.mockRejectedValue(new Error('duplicate key value violates unique constraint "x"'))
    await store.changeSelection({ date: '2026-10-02' })
    expect(store.getSnapshot().error).toBe(GENERIC)
  })
  it('invalidates quotes on enhancement changes but not contact edits', async () => {
    const { store } = fixture(); await store.loadQuote(); store.edit({ note: 'hello' })
    expect(store.getSnapshot().quote).toEqual(quote)
    store.edit({ enhancementIds: [] }); expect(store.getSnapshot().quote).toBeNull()
  })
  it('requires fresh price review when the price changes', async () => {
    const { store, api } = fixture(); await store.loadQuote(); api.quote.mockResolvedValue({ ...quote, total_gbp: 190 })
    await store.finalize(); expect(api.finalize).not.toHaveBeenCalled(); expect(store.getSnapshot().error).toContain('price has changed')
  })
  it('shows no confirmation on a database failure and allows correction', async () => {
    const { store, api } = fixture(); await store.loadQuote()
    api.finalize.mockRejectedValue({ code: '23P01', message: 'Time slot is no longer available' })
    await store.finalize()
    expect(store.getSnapshot()).toMatchObject({ result: null, error: 'Sorry, that time has just been taken. Please choose another; your details are saved.' })
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
    expect(api.finalize).not.toHaveBeenCalled(); expect(store.getSnapshot().error).toContain('released')
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


describe('hold continuation and draft recovery', () => {
  it('clears an expired hold immediately on reload while preserving the full draft', () => {
    const f = fixture()
    f.store.edit({ note: 'Saved note', sessions: [{ ...newSession(60), preference_ids: ['focus'] }, newSession(60)] })
    const before = restoreDraft(f.storage)
    const reloaded = createBookingStore({ ...f, now: () => Date.parse('2026-10-02') })
    expect(reloaded.getSnapshot()).toMatchObject({ step: 3, error: 'Your selected time was released. Please choose an available time to continue.' })
    expect(restoreDraft(f.storage)).toEqual({ ...before, hold: null, start: null })
    expect(f.api.hold).not.toHaveBeenCalled()
  })
  it('reconciles expiry during navigation without relying on a timer', () => {
    const f = fixture()
    let clock = f.now()
    const store = createBookingStore({ ...f, now: () => clock })
    store.navigate(5)
    clock += 20 * 60000
    store.navigate(4)
    expect(store.getSnapshot()).toMatchObject({ step: 3, draft: { hold: null, start: null } })
    expect(store.getSnapshot().error).toContain('Your selected time was released')
  })
  it('keeps the friendly expiry message when the server rejects a late extension', async () => {
    const f = fixture()
    f.api.extend = vi.fn().mockRejectedValue({ code: '23P01', message: 'Server expiry rejection' })
    expect(await f.store.extendHold()).toBe(false)
    expect(f.store.getSnapshot()).toMatchObject({ step: 3, draft: { hold: null, start: null },
      error: 'Your selected time was released. Please choose an available time to continue.' })
    expect(f.api.hold).not.toHaveBeenCalled()
  })
  it('never renews a hold for edits, navigation or expiry checks', () => {
    const f = fixture(); f.api.extend = vi.fn()
    f.store.edit({ note: 'Typing' }); f.store.navigate(4); f.store.expireHold()
    expect(restoreDraft(f.storage).hold).toEqual(f.draft.hold)
    expect(f.api.hold).not.toHaveBeenCalled(); expect(f.api.extend).not.toHaveBeenCalled()
  })
  it('never expires or extends a provisional booking through pre-booking hold controls', async () => {
    const f = fixture()
    f.store.edit({ bookingId: 'provisional', paymentComplete: false })
    const before = restoreDraft(f.storage)
    const reloaded = createBookingStore({ ...f, now: () => Date.parse('2026-10-02') })
    reloaded.expireHold(); await reloaded.releaseHold(); await reloaded.extendHold()
    expect(reloaded.getSnapshot().step).toBe(6)
    expect(restoreDraft(f.storage)).toEqual(before)
    expect(f.api.release).not.toHaveBeenCalled()
  })
  it('applies only a verified server extension and persists it across reload', async () => {
    const f = fixture()
    f.api.extend = vi.fn().mockResolvedValue({ hold_id: 'hold', expires_at: '2026-10-01T10:20:00Z', extension_used: true })
    await f.store.extendHold()
    expect(f.api.extend).toHaveBeenCalledWith(f.draft.hold, f.clientKey)
    const reloaded = createBookingStore(f)
    expect(reloaded.getSnapshot().draft.hold).toMatchObject({ hold_token: 'token', expires_at: '2026-10-01T10:20:00Z', extension_used: true })
  })
  it('does not advance the local timer after an extension failure', async () => {
    const f = fixture(); f.api.extend = vi.fn().mockRejectedValue(new Error('Network unavailable'))
    await f.store.extendHold()
    expect(f.store.getSnapshot().draft.hold).toEqual(f.draft.hold)
    expect(f.store.getSnapshot().error).toBe('The connection dropped. Please check it and try again.')
  })
  it.each(['release', 'expiry'])('preserves all draft fields after %s and returns to time selection', async (action) => {
    const f = fixture()
    f.store.edit({ details: { ...f.draft.details, first_name: 'Saved', address_line_1: '1 Saved Road' }, note: 'Keep notes', paymentMethod: 'cash' })
    f.store.navigate(5)
    if (action === 'release') await f.store.releaseHold()
    else { f.store.edit({ hold: { ...f.draft.hold, expires_at: '2000-01-01' } }); f.store.expireHold() }
    expect(f.store.getSnapshot().step).toBe(3)
    expect(restoreDraft(f.storage)).toMatchObject({ ...f.draft, hold: null, start: null,
      details: { ...f.draft.details, first_name: 'Saved', address_line_1: '1 Saved Road' }, note: 'Keep notes', paymentMethod: 'cash' })
  })
  it('preserves ambiguous finalization for safe retry even if its hold expires', async () => {
    const f = fixture(); await f.store.loadQuote()
    f.api.finalize.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await f.store.finalize()
    const pending = f.store.getSnapshot().draft.pending
    const reloaded = createBookingStore({ ...f, now: () => Date.parse('2026-10-02') })
    reloaded.expireHold(); await reloaded.releaseHold(); await reloaded.extendHold()
    expect(reloaded.getSnapshot().draft.pending).toEqual(pending)
    expect(reloaded.getSnapshot().step).toBe(6)
    expect(f.api.release).not.toHaveBeenCalled()
  })
})


describe('owner-aware availability adapter state', () => {
  it('passes the persisted active hold and browser key, including after reload', async () => {
    const f = fixture(); f.api.availability = vi.fn().mockResolvedValue([])
    await f.store.availability(f.draft.date, 120)
    expect(f.api.availability).toHaveBeenLastCalledWith(f.draft.date, 120, f.draft.hold, f.clientKey)
    await createBookingStore(f).availability(f.draft.date, 120)
    expect(f.api.availability).toHaveBeenLastCalledWith(f.draft.date, 120, f.draft.hold, f.clientKey)
  })
  it('does not send an expired or released hold for exclusion', async () => {
    const f = fixture(); f.api.availability = vi.fn().mockResolvedValue([])
    await createBookingStore({ ...f, now: () => Date.parse('2026-10-02') }).availability(f.draft.date, 120)
    expect(f.api.availability).toHaveBeenLastCalledWith(f.draft.date, 120, null, f.clientKey)
    await f.store.releaseHold()
    await f.store.availability(f.draft.date, 120)
    expect(f.api.availability).toHaveBeenLastCalledWith(f.draft.date, 120, null, f.clientKey)
  })
})


describe('provisional payment state', () => {
  it('stays at Payment for a server-created provisional reservation and restores after reload', async () => {
    const f = fixture(); f.api.finalize.mockResolvedValue({ booking_id: 'provisional', booking_reference: 'REF', payment_status: 'awaiting_transfer' })
    await f.store.loadQuote(); await f.store.finalize()
    expect(f.store.getSnapshot().step).toBe(6)
    expect(createBookingStore(f).getSnapshot().step).toBe(6)
    expect(f.store.getSnapshot().draft.hold).toBeNull()
  })
  it('retains an ambiguous payment action and retries it even after reload', async () => {
    const f=fixture(); f.api.finalize.mockResolvedValue({ booking_id:'provisional',booking_reference:'REF',payment_status:'awaiting_transfer' })
    await f.store.loadQuote(); await f.store.finalize()
    f.api.declareTransfer=vi.fn().mockRejectedValueOnce(new TypeError('Lost response')).mockResolvedValue({id:'provisional',booking_payments:{status:'awaiting_verification'}})
    await f.store.completePayment()
    expect(f.store.getSnapshot().step).toBe(6)
    f.store.setPaymentMethod('cash')
    expect(f.store.getSnapshot().draft.paymentMethod).toBe('bank_transfer')
    const reloaded=createBookingStore(f); await reloaded.completePayment()
    expect(reloaded.getSnapshot().step).toBe(7)
    expect(f.api.declareTransfer).toHaveBeenCalledTimes(2)
  })
})
