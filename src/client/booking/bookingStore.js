import { activeHold, allowedStep, draftKey, durationOf, restoreDraft } from './bookingDraft.js'
import { finalizeParams, quoteParams } from './bookingApi.js'

const holdReleasedMessage = 'Your selected time was released. Please choose an available time to continue.'

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
  function clearHold(message) {
    save({ ...state.draft, hold: null, start: null })
    publish({ step: allowedStep(state.draft, 3, now()), error: message })
  }
  function expireHold() {
    // An ambiguous finalization must first be retried with its original key.
    if (state.busy || state.draft.pending || state.draft.bookingId || !state.draft.hold || activeHold(state.draft, now())) return false
    try { clearHold(holdReleasedMessage); return true }
    catch (error) { publish({ error: error.message }); return false }
  }
  expireHold()
  return {
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => state,
    setError: (error) => publish({ error }),
    availability(date, duration) {
      return api.availability(date, duration, activeHold(state.draft, now()) ? state.draft.hold : null, clientKey)
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
          throw new Error('Unable to verify the hold extension. Please retry.')
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
      try { save({ ...state.draft, paymentMethod }) } catch (error) { publish({ error: error.message }) }
    },
    resumePayment(booking) {
      if (booking.id !== state.draft.bookingId) return
      if (booking.booking_payments.status !== 'awaiting_transfer' && !booking.reservation_expired) {
        try { save({ ...state.draft, paymentComplete: true, paymentPending: null }); publish({ step: 7 }) }
        catch (error) { publish({ error: error.message }) }
      }
    },
    completePayment() { return run(async () => {
      if (!state.draft.bookingId) return
      const action = state.draft.paymentPending || state.draft.paymentMethod
      save({ ...state.draft, paymentPending: action })
      const booking = await (action === 'cash' ? api.confirmCash(state.draft.bookingId) : api.declareTransfer(state.draft.bookingId))
      if (booking.id !== state.draft.bookingId || booking.reservation_expired || booking.booking_payments.status === 'awaiting_transfer') {
        throw new Error('Unable to verify your payment request. Please retry.')
      }
      save({ ...state.draft, paymentComplete: true, paymentPending: null })
      publish({ step: 7 })
      return booking
    }) },
    restartExpiredPayment() { return run(async () => {
      const booking = await api.booking(state.draft.bookingId)
      if (!booking.reservation_expired) throw new Error('This reservation is still active. Please refresh its payment details.')
      save({ ...state.draft, bookingId: null, paymentComplete: false, paymentPending: null, pending: null, hold: null, start: null, paymentMethod: 'bank_transfer' })
      publish({ step: 3, result: null, quote: null })
    }) },
    navigate(step) {
      if (!expireHold()) publish({ step: allowedStep(state.draft, step, now()), error: '' })
    },
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
      save({ ...state.draft, start, hold: { ...hold, extension_used: hold.hold_id === state.draft.hold?.hold_id && state.draft.hold.extension_used } })
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
        if (/^[0-9A-Z]{5}$/.test(error.code || '') && !error.code.startsWith('PGRST')) {
          save({ ...state.draft, pending: null })
          if (error.code === '23P01') clearHold('Your time is no longer available. Choose another time; your details are saved.')
        }
        throw error
      }
      if (!result.booking_id || !result.booking_reference) throw new Error('Unable to verify the booking result. Please retry the same request.')
      const paymentComplete = result.payment_status !== 'awaiting_transfer'
      save({ ...state.draft, bookingId: result.booking_id, pending: null, hold: null, paymentComplete })
      publish({ result, step: paymentComplete ? 7 : 6 })
      return result
    }) },
  }
}
