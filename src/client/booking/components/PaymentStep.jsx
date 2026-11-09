import { useEffect, useRef, useState } from 'react'
import { money } from '../bookingDraft.js'
import { cancellationNote } from '../../bookingRules.js'
import { friendlyError } from '../friendlyError.js'
import { PriceSummary } from './ReviewStep.jsx'
import BankDetails from './BankDetails.jsx'
import BookingSummary from './BookingSummary.jsx'
import { postcodeOf } from '../../../lib/address.js'
import { payAfterChoice, sessionDay, shortDay } from '../payAfter.js'

// The two ways to pay sit side by side near the top of the page, so cash is as easy to find as a bank transfer.
// For a later session (`after` is the earlier one), the bank transfer is made after that session.
function MethodChoice({ cash, locked, choose, after }) {
  return <section aria-labelledby="method-title">
    <h2 className="section-title" id="method-title">{after ? 'How would you like to pay for it?' : 'How would you like to pay?'}</h2>
    <div className="tiles tiles--methods">
      <button type="button" className="tile" aria-pressed={!cash} disabled={locked} onClick={() => cash && choose()}><span className="tile-title">Bank transfer</span><span className="tile-note">{after ? `After your ${shortDay(after.date)} session` : 'Pay now with your reference'}</span></button>
      <button type="button" className="tile" aria-pressed={cash} disabled={locked} onClick={() => !cash && choose()}><span className="tile-title">Cash</span><span className="tile-note">{after ? 'At this appointment' : 'Pay at your appointment'}</span></button>
    </div>
  </section>
}

export default function PaymentStep({ rules, draft, quote, quoteError, bank, api, store, finalize, held, error, chooseTimeAgain }) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [termsHint, setTermsHint] = useState(false)
  const termsBox = useRef(null)
  const errorBox = useRef(null)
  const [view, setView] = useState({ booking: null, error: '' })
  const [attempt, setAttempt] = useState(0)
  // A later session can still be paid now, the usual way, if the client would rather.
  const [payNow, setPayNow] = useState(false)
  useEffect(() => {
    if (!draft.bookingId) return
    let live = true
    api.booking(draft.bookingId).then((booking) => {
      if (live) { setView({ booking, error: '' }); store.resumePayment(booking) }
    }).catch((err) => { if (live) setView({ booking: null, error: friendlyError(err) }) })
    return () => { live = false }
  }, [api, draft.bookingId, attempt, store])
  // A message about what just went wrong is brought into view: the button that caused it is stuck to the bottom of the screen.
  useEffect(() => { if (error) errorBox.current?.scrollIntoView({ block: 'center' }) }, [error])
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
  // A postcode outside the areas, or none: the booking is made and waits for Vad, who confirms it (and sends the payment details) or gets in touch.
  // Nothing is to be paid until then, so the bank details are not shown.
  const areaNote = booking.area_check && `${booking.area_check === 'outside' ? `${postcodeOf(booking.address_snapshot) || 'Your postcode'} is outside my usual areas` : "I couldn't see a postcode in your address"}, so I'll check I can come to you first.`
  if (areaNote && !cash) return <>
    <h1 tabIndex={-1}>I've <em>received</em> your request</h1>
    <p role="status" className="reserved"><span className="reserved-dot" aria-hidden="true" />Your appointment time is reserved for you.</p>
    <p className="lede">{areaNote} Please don't make a transfer yet. Once your appointment is confirmed, I'll email you the amount and the bank details.</p>
    <MethodChoice cash={cash} locked={Boolean(draft.paymentPending)} choose={switchMethod} />
    <BookingSummary booking={booking} quote={quote} />
    <a className="btn btn--quiet btn--block" href={`/account?booking=${booking.id}`}>Change the time or cancel this booking</a>
    <p className="fine"><a href="https://vadmassage.com">Contact Vadim</a></p>
  </>
  // Switching between bank transfer and cash starts the acknowledgement again, since the terms read differently, and tells a screen reader the page changed.
  function switchMethod() {
    store.setPaymentMethod(cash ? 'bank_transfer' : 'cash')
    setAcknowledged(false)
    setTermsHint(false)
    setTimeout(() => document.querySelector('.booking-main h1')?.focus({ preventScroll: true }), 0)
  }
  const summary = <BookingSummary booking={booking} paymentLabel={cash ? 'Cash on arrival' : undefined} quote={quote} />
  // The button is always there to press; if the terms have not been ticked it says so and takes her to the box.
  function confirm(choice) {
    if (!acknowledged) {
      setTermsHint(true)
      termsBox.current?.closest('label')?.scrollIntoView({ block: 'center' })
      termsBox.current?.focus({ preventScroll: true })
      return
    }
    store.completePayment(choice)
  }
  const terms = <>
    <p className="terms-note" id="terms-note">{cancellationNote(rules)}</p>
    <label className="check terms"><input ref={termsBox} type="checkbox" aria-describedby={termsHint && !acknowledged ? 'terms-note terms-help' : 'terms-note'} checked={acknowledged} onChange={(event) => { setAcknowledged(event.target.checked); if (event.target.checked) setTermsHint(false) }} />I understand the payment and cancellation terms.</label>
    {termsHint && !acknowledged && <p role="alert" className="error" id="terms-help">Please tick the box to say you understand the terms, then press the button again.</p>}
    {error && <p role="alert" className="error" ref={errorBox}>{error}</p>}
  </>
  // A later session (the client has an earlier one still to come): nothing to pay yet. It is paid after the earlier session, and is confirmed
  // straight away when that one is confirmed, or as soon as it is (ADR-097). A "pay_after" left pending by a lost answer is retried here too.
  const earlier = payAfterChoice(booking, cash)
  if (earlier && (!payNow || draft.paymentPending === 'pay_after')) {
    const earlierDay = shortDay(earlier.date)
    return <>
      <h1 tabIndex={-1}>Nothing to pay <em>yet</em></h1>
      <p role="status" className="reserved"><span className="reserved-dot" aria-hidden="true" />Your appointment time is reserved for you.</p>
      <section className="pay-after-note" aria-labelledby="pay-after-title">
        <h2 id="pay-after-title">You pay for one session at a time</h2>
        <p>You already have a session with me on <strong>{sessionDay(earlier.date)}</strong>. Pay for this one after that session. I'll send you the amount and bank details then.</p>
      </section>
      <MethodChoice cash={cash} locked={Boolean(draft.paymentPending)} choose={switchMethod} after={earlier} />
      <h2 className="section-title">What happens next</h2>
      <ol role="list" className="steps-list">
        <li>Press <strong>Book this session</strong>. {earlier.auto_confirm === false ? "I'll look at it and confirm it." : earlier.booking_status === 'confirmed' ? "It's confirmed straight away." : `It's confirmed as soon as your ${earlierDay} session is.`}</li>
        <li>After your {earlierDay} session, I'll send you {money(booking.total_gbp)} to pay for this one.</li>
        <li>Pay it before {shortDay(booking.date)}.</li>
      </ol>
      {terms}
      {summary}
      {!draft.paymentPending && <button type="button" className="btn--quiet btn--block" onClick={() => setPayNow(true)}>I'd rather pay for this one now</button>}
      <a className="btn btn--quiet btn--block" href={`/account?booking=${booking.id}`}>Change the time or cancel this booking</a>
      <p className="fine"><a href="https://vadmassage.com">Contact Vadim</a></p>
      <div className="action-bar">
        <button className="btn--primary btn--lg btn--block" onClick={() => confirm('pay_after')}>{draft.paymentPending ? 'Try again' : 'Book this session'}</button>
      </div>
    </>
  }
  return <>
    <h1 tabIndex={-1}>{cash ? <>Paying by <em>cash</em></> : <>One last <em>step</em></>}</h1>
    <p role="status" className="reserved"><span className="reserved-dot" aria-hidden="true" />Your appointment time is reserved for you.</p>
    <MethodChoice cash={cash} locked={Boolean(draft.paymentPending)} choose={switchMethod} />
    <p className="lede">{cash ? "Pay the full amount in cash at your appointment. Press the button below to send me your request, and I'll look at it and confirm your appointment." : 'Please make your bank transfer using the reference below, then let me know.'}</p>
    <section className="amount-card" aria-label={cash ? 'Amount to pay in cash' : 'Amount to transfer'}>
      <p className="eyebrow">{cash ? 'To pay in cash at your appointment' : 'Amount to transfer'}</p>
      <p className="amount figure">{money(booking.total_gbp)}</p>
    </section>
    {!cash && <section className="panel bank-card">
      <h2>Bank transfer</h2>
      <BankDetails bank={bank} reference={booking.booking_payments.payment_reference} />
    </section>}
    {cash && <section className="panel">
      <h2>Cash on arrival</h2>
      <p>You can pay the full amount in cash at your appointment.</p>
      {areaNote && <p>{areaNote}</p>}
    </section>}
    {terms}
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
    {summary}
    <a className="btn btn--quiet btn--block" href={`/account?booking=${booking.id}`}>Change the time or cancel this booking</a>
    <p className="fine"><a href="https://vadmassage.com">Contact Vadim</a></p>
    <div className="action-bar">
      <button className="btn--primary btn--lg btn--block" disabled={!cash && !bank.configured} onClick={() => confirm()}>
        {draft.paymentPending ? 'Try again' : cash ? 'Confirm cash booking' : "I've made the bank transfer"}
      </button>
    </div>
  </>
}
