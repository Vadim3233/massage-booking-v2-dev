import { useState } from 'react'
import { PriceSummary } from './ReviewStep.jsx'

export function BankDetails({ bank }) {
  return bank.configured ? <dl className="prices">
    <div><dt>Account name</dt><dd>{bank.accountName}</dd></div>
    <div><dt>Sort code</dt><dd>{bank.sortCode}</dd></div>
    <div><dt>Account number</dt><dd>{bank.accountNumber}</dd></div>
  </dl> : <p role="status">Bank-transfer details are currently unavailable. Please contact Vad before making a transfer.</p>
}

export default function PaymentStep({ draft, quote, bank, edit, refresh, finalize, held, error, chooseTimeAgain }) {
  const [acknowledged, setAcknowledged] = useState(false)

  if (draft.pending) return <><h1>Check your booking request</h1>
    <p>The result of your last request has not been verified. Retry it to retrieve the result safely. Your selections are locked to avoid a duplicate booking.</p>
    {error && <p role="alert" className="error">{error}</p>}
    <button className="primary" onClick={finalize}>Retry booking request</button>
  </>

  if (!held) return <><h1>Your time hold expired</h1>
    <p>Your booking details are still saved, but the selected time is no longer reserved.</p>
    <button className="primary" onClick={chooseTimeAgain}>Choose a new time</button>
  </>

  return <><h1>One last step</h1><PriceSummary quote={quote} /><button onClick={refresh}>Refresh price</button>
    <label className="check"><input type="radio" name="payment" checked={draft.paymentMethod === 'bank_transfer'} onChange={() => edit({ paymentMethod: 'bank_transfer' })} />Bank transfer</label>
    <label className="check"><input type="radio" name="payment" checked={draft.paymentMethod === 'cash'} onChange={() => edit({ paymentMethod: 'cash' })} />Request cash payment</label>
    {draft.paymentMethod === 'bank_transfer' ? <section className="panel"><h2>Bank transfer</h2>
      <BankDetails bank={bank} />
      <p>Submit your booking to receive its payment reference, then use that reference for your transfer. Vad will check your payment before confirming the appointment.</p>
    </section> : <section className="panel"><h2>Cash requires approval</h2><p>Your request will be sent to Vad for approval. Your appointment is not confirmed until approved.</p></section>}
    <p>Free cancellation up to 24 hours before your appointment. Within 24 hours, the full appointment fee may apply.</p>
    <label className="check"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />I understand the payment and cancellation terms.</label>
    {error && <p role="alert" className="error">{error}</p>}
    <button className="primary" disabled={!quote || !acknowledged || (draft.paymentMethod === 'bank_transfer' && !bank.configured)} onClick={finalize}>
      {draft.paymentMethod === 'cash' ? 'Request cash payment' : 'Submit bank-transfer booking'}
    </button>
  </>
}
