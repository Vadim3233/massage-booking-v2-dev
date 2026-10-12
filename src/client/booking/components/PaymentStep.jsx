import { useEffect, useRef, useState } from 'react'
import { money } from '../bookingDraft.js'
import { cancellationNote } from '../../bookingRules.js'
import { friendlyError } from '../friendlyError.js'
import { PriceSummary } from './ReviewStep.jsx'
import BankDetails from './BankDetails.jsx'
import BookingSummary from './BookingSummary.jsx'

export default function PaymentStep({ rules, draft, quote, quoteError, bank, api, store, finalize, held, error, chooseTimeAgain }) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [termsHint, setTermsHint] = useState(false)
  const termsBox = useRef(null)
  const [view, setView] = useState({ booking: null, error: '' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!draft.bookingId) return
    let live = true
    api.booking(draft.bookingId).then((booking) => {
      if (live) { setView({ booking, error: '' }); store.resumePayment(booking) }
    }).catch((err) => { if (live) setView({ booking: null, error: friendlyError(err) }) })
    return () => { live = false }
  }, [api, draft.bookingId, attempt, store])
  // Coming back to this step before the reservation exists (a reload, say) still shows the price.
  useEffect(() => { if (!draft.bookingId && !quote && !quoteError) store.refreshQuote() }, [draft.bookingId, quote, quoteError, store])
  if (!draft.bookingId) return <><h1 tabIndex={-1}>One last <em>step</em></h1><PriceSummary quote={quote} quoteError={quoteError} retry={store.retryQuote} />
    <p>{draft.pending ? "The connection dropped before I could tell whether your appointment was reserved. Please try again; you won't be booked twice." : 'Reserve your appointment to receive the payment reference before making a transfer.'}</p>
    {error && <p role="alert" className="error">{error}</p>}
    {held || draft.pending ? <><div className="action-bar"><button className="btn--primary btn--lg btn--block" onClick={finalize}>{draft.pending ? 'Try again' : 'Reserve appointment'}</button></div><button className="btn--quiet" onClick={store.retryQuote}>Refresh price</button></> : <button className="btn--primary btn--lg btn--block" onClick={chooseTimeAgain}>Choose a new time</button>}
  </>
  const booking = view.booking
  if (!booking) return <><h1 tabIndex={-1}>One last <em>step</em></h1><p role="status">Loading your payment reservation…</p>{view.error && <p role="alert" className="error">{view.error}</p>}<button onClick={() => setAttempt(attempt + 1)}>Refresh reservation</button></>
  const cash = draft.paymentMethod === 'cash'
  // Switching between bank transfer and cash starts the acknowledgement again, since the terms read differently, and tells a screen reader the page changed.
  function switchMethod() {
    store.setPaymentMethod(cash ? 'bank_transfer' : 'cash')
    setAcknowledged(false)
    setTimeout(() => document.querySelector('.booking-main h1')?.focus({ preventScroll: true }), 0)
  }
  // The button is always there to press; if the terms have not been ticked it says so and takes her to the box.
  function confirm() {
    if (!acknowledged) {
      setTermsHint(true)
      termsBox.current?.scrollIntoView({ block: 'center' })
      termsBox.current?.focus({ preventScroll: true })
      return
    }
    store.completePayment()
  }
  const summary = <BookingSummary booking={booking} paymentLabel={cash ? 'Cash on arrival' : undefined} />
  return <>
    <h1 tabIndex={-1}>{cash ? <>Paying by <em>cash</em></> : <>One last <em>step</em></>}</h1>
    <p role="status" className="reserved"><span className="reserved-dot" aria-hidden="true" />Your appointment time is reserved for you.</p>
    <p className="lede">{cash ? "Pay the full amount in cash at your appointment. Press the button below to send me your request, and I'll look at it and confirm your appointment." : 'Please make your bank transfer using the reference below, then let me know.'}</p>
    {!cash && <section className="amount-card" aria-label="Amount to transfer">
      <p className="eyebrow">Amount to transfer</p>
      <p className="amount figure">{money(booking.total_gbp)}</p>
    </section>}
    {!cash && <section className="panel bank-card">
      <h2>Bank transfer</h2>
      <BankDetails bank={bank} reference={booking.booking_payments.payment_reference} />
    </section>}
    {cash && <section className="panel">
      <h2>Cash on arrival</h2>
      <p>You can pay the full amount in cash at your appointment.</p>
    </section>}
    <p className="terms-note" id="terms-note">{cancellationNote(rules)}</p>
    <label className="check terms"><input ref={termsBox} type="checkbox" aria-describedby={termsHint && !acknowledged ? 'terms-note terms-help' : 'terms-note'} checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />I understand the payment and cancellation terms.</label>
    {termsHint && !acknowledged && <p role="alert" className="error" id="terms-help">Please tick the box to say you understand the terms, then press the button again.</p>}
    <h2 className="section-title">What happens next</h2>
    <ol role="list" className="steps-list">
      {cash ? <>
        <li>Confirm your cash booking below.</li>
        <li>I'll look at your request, confirm your appointment and let you know.</li>
      </> : <>
        <li>Make the bank transfer.</li>
        <li>Press <strong>I've made the bank transfer</strong>.</li>
        <li>I'll check the payment and confirm your appointment.</li>
      </>}
    </ol>
    {!draft.paymentPending && <button className="btn--quiet switch-method" onClick={switchMethod}>{cash ? 'Back to bank transfer' : "I'd like to pay cash"}</button>}
    {summary}
    <p className="fine"><a href="https://vadmassage.com">Contact Vad</a></p>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="action-bar">
      <button className="btn--primary btn--lg btn--block" disabled={!cash && !bank.configured} onClick={confirm}>
        {draft.paymentPending ? 'Try again' : cash ? 'Confirm cash booking' : "I've made the bank transfer"}
      </button>
    </div>
  </>
}
