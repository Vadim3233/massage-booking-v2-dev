import { useEffect, useState } from 'react'
import { money } from '../bookingDraft.js'
import { PriceSummary } from './ReviewStep.jsx'
import BankDetails from './BankDetails.jsx'
import BookingSummary from './BookingSummary.jsx'

export default function PaymentStep({ draft, quote, bank, api, store, finalize, held, error, chooseTimeAgain }) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [view, setView] = useState({ booking: null, error: '' })
  const [attempt, setAttempt] = useState(0)
  const [clock, setClock] = useState(Date.now)
  useEffect(() => {
    if (!draft.bookingId) return
    let live = true
    api.booking(draft.bookingId).then((booking) => {
      if (live) { setClock(Date.now()); setView({ booking, error: '' }); store.resumePayment(booking) }
    }).catch((err) => { if (live) setView({ booking: null, error: err.message }) })
    return () => { live = false }
  }, [api, draft.bookingId, attempt, store])
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer) }, [])
  if (!draft.bookingId) return <><h1>One last step</h1><PriceSummary quote={quote} />
    <p>{draft.pending ? 'Your reservation response was interrupted. Retry the same request safely.' : 'Reserve your appointment to receive the payment reference before making a transfer.'}</p>
    {error && <p role="alert" className="error">{error}</p>}
    {held || draft.pending ? <><button className="primary" onClick={finalize}>{draft.pending ? 'Retry booking request' : 'Reserve appointment'}</button><button onClick={store.loadQuote}>Refresh price</button></> : <button onClick={chooseTimeAgain}>Choose a new time</button>}
  </>
  const booking = view.booking
  if (!booking) return <><h1>One last step</h1><p>Loading your payment reservation…</p>{view.error && <p role="alert">{view.error}</p>}<button onClick={() => setAttempt(attempt + 1)}>Refresh reservation</button></>
  const remaining = Math.min(3600, Math.max(0, Math.ceil((Date.parse(booking.payment_reservation_expires_at) - clock) / 1000)))
  const expired = booking.reservation_expired || remaining === 0
  const cash = draft.paymentMethod === 'cash'
  return <><h1>{cash ? 'Paying by cash' : 'One last step'}</h1>
    {expired ? <p role="alert">Your payment reservation has expired. Your details are saved. If you already sent money, contact Vad before booking again.</p>
      : <><p role="status">Your payment reservation expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}.</p>
        <p>{cash ? "Thank you. I'll confirm your appointment as soon as possible." : 'Please make your bank transfer using the reference below, then let me know.'}</p></>}
    <BookingSummary booking={booking} paymentLabel={cash ? 'Cash on arrival' : undefined} />
    {!cash && !expired && <section className="panel">
      <h2>Bank transfer</h2>
      <p>Amount to transfer: <strong>{money(booking.total_gbp)}</strong></p>
      <BankDetails bank={bank} reference={booking.booking_payments.payment_reference} />
      <h3>What happens next</h3>
      <ol>
        <li>Make the bank transfer.</li>
        <li>Press <strong>I've made the bank transfer</strong>.</li>
        <li>I'll check the payment and confirm your appointment.</li>
      </ol>
    </section>}
    {cash && !expired && <section className="panel">
      <h2>Cash on arrival</h2>
      <p>You can pay the full amount in cash at your appointment.</p>
      <h3>What happens next</h3>
      <ol>
        <li>Confirm your cash booking below.</li>
        <li>I'll confirm your appointment as soon as possible.</li>
        <li>You'll receive confirmation by email.</li>
      </ol>
    </section>}
    {!expired && <>
      <p>{cash ? 'Just a quick reminder: the full appointment fee applies to cancellations made within 24 hours of your appointment.' : 'Free cancellation up to 24 hours before your appointment. Cancellations within 24 hours are subject to the full appointment fee.'}</p>
      <label className="check"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />I understand the payment and cancellation terms.</label>
    </>}
    {error && <p role="alert" className="error">{error}</p>}
    {expired ? <button onClick={store.restartExpiredPayment}>Choose another time</button> : <>
      <button className="primary" disabled={!acknowledged || (!cash && !bank.configured)} onClick={store.completePayment}>
        {draft.paymentPending ? 'Retry payment request' : cash ? 'Confirm cash booking' : "I've made the bank transfer"}
      </button>
      {!draft.paymentPending && <button onClick={() => store.setPaymentMethod(cash ? 'bank_transfer' : 'cash')}>{cash ? 'Back to bank transfer' : "I'd like to pay cash"}</button>}
    </>}
    <p><a href="https://vadmassage.com">Contact Vad</a></p>
  </>
}
