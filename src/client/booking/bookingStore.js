import { activeHold, allowedStep, draftKey, durationOf, restoreDraft } from './bookingDraft.js'
import { finalizeParams, quoteParams } from './bookingApi.js'
import { friendlyError } from './friendlyError.js'

const holdReleasedMessage = 'Your selected time was released. Please choose an available time to continue.'

// Only what changes the price: the area, the treatment, the lengths and the extras. A name or a preference does not.
const priceInputs = (draft) => JSON.stringify([draft.areaId, draft.serviceId, draft.sessions.map((session) => session.duration_minutes), [...draft.enhancementIds].sort()])

// One owner for draft mutations and writes; synchronous busy guard prevents double clicks.
export function createBookingStore({ api, storage, clientKey, uuid = () => crypto.randomUUID(), now = () => Date.now() }) {
  let state = { draft: restoreDraft(storage), step: 0, busy: false, error: '', quote: null, quoteError: '', result: null }
  let quoting = null
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
      publish({ error: friendlyError(error) })
    } finally { publish({ busy: false }) }
  }
  function clearHold(message) {
    save({ ...state.draft, hold: null, start: null })
    publish({ step: allowedStep(state.draft, 3, now()), error: message })
  }
  function expireHold() {
    // An ambiguous finalization must first be retried with its original key.
    if (state.busy || state.draft.pending || state.draft.bookingId || !state.draft.hold || activeHold(state.draft, now())) return false
    try { clearHold(holdReleasedMessage); return true }
    catch (error) { publish({ error: friendlyError(error) }); return false }
  }
  // Keeps the price on the review page up to date without locking the screen. A price for choices that have since changed is dropped.
  function refreshQuote() {
    const key = JSON.stringify(quoteParams(state.draft))
    if (quoting?.key === key) return quoting.promise
    const current = () => JSON.stringify(quoteParams(state.draft)) === key
    const promise = api.quote(state.draft).then(
      (quote) => { if (current()) publish({ quote, quoteError: '' }); return quote },
      () => { if (current()) publish({ quoteError: "I couldn't update the price just now." }) },
    ).finally(() => { if (quoting?.promise === promise) quoting = null })
    quoting = { key, promise }
    return promise
  }
  function retryQuote() {
    publish({ quote: null, quoteError: '' })
    return refreshQuote()
  }
  expireHold()
  return {
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => state,
    setError: (error) => publish({ error }),
    async availability(date, duration) {
      const hold = activeHold(state.draft, now()) ? state.draft.hold : null
      try { return await api.availability(date, duration, hold, clientKey) }
      catch (error) {
        // The server has already let the hold go although this phone's clock says it is still running (a slow clock, or the hold was
        // released elsewhere): the hold is dropped here too and the times are loaded without it, instead of failing on every day.
        if (!hold || error?.code !== '42501' || state.draft.pending || state.draft.bookingId) throw error
        clearHold(holdReleasedMessage)
        return api.availability(date, duration, null, clientKey)
      }
    },
    expireHold,
    releaseHold() { return run(async () => {
      if (state.draft.pending || state.draft.bookingId || !state.draft.hold) return
      await api.release(state.draft.hold, clientKey)
      clearHold(holdReleasedMessage)
      return true
    }) },
    extendHold() { return run(async () => {
      if (state.draft.pending || state.draft.bookingId || !state.draft.hold) return
      try {
        const extension = await api.extend(state.draft.hold, clientKey)
        if (extension.hold_id !== state.draft.hold.hold_id || !Number.isFinite(Date.parse(extension.expires_at)) || extension.extension_used !== true) {
          throw new Error("I couldn't keep your time just now. Please try again.")
        }
        save({ ...state.draft, hold: { ...state.draft.hold, ...extension } })
        return true
      } catch (error) {
        if (error.code === '23P01') { clearHold(holdReleasedMessage); return false }
        throw error
      }
    }) },
    setPaymentMethod(paymentMethod) {
      if (state.busy || state.draft.paymentPending || state.draft.paymentComplete || !['cash', 'bank_transfer'].includes(paymentMethod)) return
      try { save({ ...state.draft, paymentMethod }) } catch (error) { publish({ error: friendlyError(error) }) }
    },
    resumePayment(booking) {
      if (booking.id !== state.draft.bookingId) return
      if (booking.booking_payments.status !== 'awaiting_transfer') {
        try { save({ ...state.draft, paymentComplete: true, paymentPending: null }); publish({ step: 7 }) }
        catch (error) { publish({ error: friendlyError(error) }) }
      }
    },
    completePayment() { return run(async () => {
      if (!state.draft.bookingId) return
      const action = state.draft.paymentPending || state.draft.paymentMethod
      save({ ...state.draft, paymentPending: action })
      const booking = await (action === 'cash' ? api.confirmCash(state.draft.bookingId) : api.declareTransfer(state.draft.bookingId))
      if (booking.id !== state.draft.bookingId || booking.booking_payments.status === 'awaiting_transfer') {
        throw new Error("I couldn't check that your request went through. Please try again; nothing will be recorded twice.")
      }
      save({ ...state.draft, paymentComplete: true, paymentPending: null })
      publish({ step: 7 })
      return booking
    }) },
    navigate(step) {
      if (!expireHold()) publish({ step: allowedStep(state.draft, step, now()), error: '' })
    },
    edit(patch) {
      if (state.busy || state.draft.pending || state.draft.bookingId) return
      try {
        const draft = { ...state.draft, ...patch }
        const priceChanged = priceInputs(draft) !== priceInputs(state.draft)
        save(draft); publish({ quote: priceChanged ? null : state.quote, quoteError: priceChanged ? '' : state.quoteError, error: '' })
      }
      catch (error) { publish({ error: friendlyError(error) }) }
    },
    changeSelection(patch) { return run(async () => {
      if (state.draft.pending || state.draft.bookingId) return
      if (state.draft.hold) await api.release(state.draft.hold, clientKey)
      save({ ...state.draft, ...patch, hold: null, start: null })
      publish({ quote: null })
      return true
    }) },
    // The day being looked at is only saved with a chosen time, so browsing other days never lets go of a time already held.
    selectSlot(start, date = state.draft.date) { return run(async () => {
      if (state.draft.pending || state.draft.bookingId) return
      await api.ensureSession?.()
      const hold = await api.hold(date, start, durationOf(state.draft), clientKey)
      // create_booking_hold atomically replaces any previous hold for this key.
      save({ ...state.draft, date, start, hold: { ...hold, extension_used: hold.hold_id === state.draft.hold?.hold_id && state.draft.hold.extension_used } })
      return true
    }) },
    loadQuote() { return run(async () => {
      publish({ quote: null, quoteError: '' })
      const quote = await api.quote(state.draft)
      publish({ quote })
      return quote
    }) },
    refreshQuote,
    retryQuote,
    finalize(userId) { return run(async () => {
      if (state.draft.bookingId) return
      if (state.draft.ownerUserId && state.draft.ownerUserId !== userId) throw new Error('Please sign in with the account used for this booking request.')
      if (!state.draft.pending) {
        if (!activeHold(state.draft, now())) throw new Error(holdReleasedMessage)
        const quote = await api.quote(state.draft)
        const previous = state.quote
        publish({ quote })
        if (!previous || ['total_gbp', 'service_subtotal_gbp', 'enhancements_total_gbp', 'travel_fee_gbp', 'congestion_fee_gbp'].some((key) => Number(previous[key]) !== Number(quote[key]))) {
          throw new Error('The price has changed. Please check the total, then press Reserve appointment again.')
        }
        save({ ...state.draft, pending: finalizeParams(state.draft, clientKey, uuid()) })
      }
      let result
      try { result = await api.finalize(state.draft.pending) }
      catch (error) {
        // PostgreSQL errors roll back the transaction. Transport errors are ambiguous.
        if (/^[0-9A-Z]{5}$/.test(error.code || '') && !error.code.startsWith('PGRST')) {
          save({ ...state.draft, pending: null })
          if (error.code === '23P01') {
            // The refused time is let go at once, so it does not stay blocked for others until the hold runs out.
            const refused = state.draft.hold
            if (refused) await api.release(refused, clientKey).catch(() => {})
            clearHold('Your time is no longer available. Choose another time; your details are saved.')
          }
        }
        throw error
      }
      if (!result.booking_id || !result.booking_reference) throw new Error("I couldn't check that your booking was saved. Please try again; you won't be booked twice.")
      const paymentComplete = result.payment_status !== 'awaiting_transfer'
      save({ ...state.draft, bookingId: result.booking_id, pending: null, hold: null, paymentComplete })
      publish({ result, step: paymentComplete ? 7 : 6 })
      return result
    }) },
  }
}
