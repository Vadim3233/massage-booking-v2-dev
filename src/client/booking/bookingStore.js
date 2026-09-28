import { activeHold, allowedStep, draftKey, durationOf, restoreDraft } from './bookingDraft.js'
import { finalizeParams, quoteParams } from './bookingApi.js'

// One owner for draft mutations and writes; synchronous busy guard prevents double clicks.
export function createBookingStore({ api, storage, clientKey, uuid = () => crypto.randomUUID(), now = () => Date.now() }) {
  let state = { draft: restoreDraft(storage), step: 0, busy: false, error: '', quote: null, result: null }
  state.step = allowedStep(state.draft, Number(new URLSearchParams(globalThis.location?.search).get('step')) || 0, now())
  const listeners = new Set()
  function publish(patch) { state = { ...state, ...patch }; listeners.forEach((listener) => listener()) }
  function save(draft) {
    // Persist BEFORE a network write: an ambiguous response must be safely retryable.
    storage.setItem(draftKey, JSON.stringify({ version: 1, draft }))
    publish({ draft })
  }
  async function run(action) {
    if (state.busy) return
    publish({ busy: true, error: '' })
    try { return await action() } catch (error) {
      publish({ error: error.message || 'Unable to complete this request. Please retry.' })
    } finally { publish({ busy: false }) }
  }
  return {
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => state,
    setError: (error) => publish({ error }),
    navigate(step) { publish({ step: allowedStep(state.draft, step, now()), error: '' }) },
    edit(patch) {
      if (state.busy || state.draft.pending || state.draft.bookingId) return
      try {
        const draft = { ...state.draft, ...patch }
        const changed = JSON.stringify(quoteParams(draft)) !== JSON.stringify(quoteParams(state.draft))
        save(draft); publish({ quote: changed ? null : state.quote, error: '' })
      }
      catch (error) { publish({ error: error.message }) }
    },
    changeSelection(patch) { return run(async () => {
      if (state.draft.pending || state.draft.bookingId) return
      if (state.draft.hold) await api.release(state.draft.hold, clientKey)
      save({ ...state.draft, ...patch, hold: null, start: null })
      publish({ quote: null })
      return true
    }) },
    selectSlot(start) { return run(async () => {
      if (state.draft.pending || state.draft.bookingId) return
      const hold = await api.hold(state.draft.date, start, durationOf(state.draft), clientKey)
      // create_booking_hold atomically replaces any previous hold for this key.
      save({ ...state.draft, start, hold })
      return true
    }) },
    loadQuote() { return run(async () => {
      publish({ quote: null })
      const quote = await api.quote(state.draft)
      publish({ quote })
      return quote
    }) },
    finalize(userId) { return run(async () => {
      if (state.draft.bookingId) return
      if (state.draft.ownerUserId && state.draft.ownerUserId !== userId) throw new Error('Sign in with the account used for this booking request.')
      if (!state.draft.pending) {
        if (!activeHold(state.draft, now())) throw new Error('Your time hold has expired. Please choose a time again.')
        const quote = await api.quote(state.draft)
        const previous = state.quote
        publish({ quote })
        if (!previous || ['total_gbp', 'service_subtotal_gbp', 'enhancements_total_gbp', 'travel_fee_gbp', 'congestion_fee_gbp'].some((key) => Number(previous[key]) !== Number(quote[key]))) {
          throw new Error('Please review the refreshed price and confirm again.')
        }
        save({ ...state.draft, pending: finalizeParams(state.draft, clientKey, uuid()) })
      }
      let result
      try { result = await api.finalize(state.draft.pending) }
      catch (error) {
        // PostgreSQL errors roll back the transaction. Transport errors are ambiguous.
        if (/^[0-9A-Z]{5}$/.test(error.code || '') && !error.code.startsWith('PGRST')) save({ ...state.draft, pending: null })
        throw error
      }
      if (!result.booking_id || !result.booking_reference) throw new Error('Unable to verify the booking result. Please retry the same request.')
      save({ ...state.draft, bookingId: result.booking_id, pending: null, hold: null })
      publish({ result, step: 7 })
      return result
    }) },
  }
}
