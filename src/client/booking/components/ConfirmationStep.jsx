import { useEffect, useState } from 'react'
import BankDetails from './BankDetails.jsx'
import BookingSummary from './BookingSummary.jsx'

export default function ConfirmationStep({ id, api, bank }) {
  const [view, setView] = useState({ booking: null, error: '' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    api.booking(id).then((booking) => { if (live) setView({ booking, error: '' }) })
      .catch((error) => { if (live) setView({ booking: null, error: error.message }) })
    return () => { live = false }
  }, [api, id, attempt])
  const booking = view.booking
  if (!booking) return <><h1>Retrieve your booking</h1><p>Loading your saved appointment…</p>{view.error && <><p role="alert">{view.error}</p><button onClick={() => setAttempt(attempt + 1)}>Retry loading booking</button></>}</>
  if (booking.reservation_expired || booking.booking_payments.status === 'awaiting_transfer') return <><h1>Your transfer has not been declared</h1><p>Please return to Payment to complete your request.</p></>
  const bankTransfer = booking.booking_payments.method === 'bank_transfer'
  return <>
    <h1>I've received your booking</h1>
    <p>{bankTransfer ? "Thank you. I look forward to seeing you. I'll check your transfer and confirm your appointment as soon as possible." : "Thank you. I look forward to seeing you. I'll confirm your appointment as soon as possible."}</p>
    <BookingSummary booking={booking} />
    <section><h2>What happens next</h2>
      {bankTransfer ? <ol>
        <li>I'll check your transfer.</li>
        <li>I'll contact you once your appointment is confirmed.</li>
        <li>Keep your booking reference for future enquiries.</li>
      </ol> : <ol>
        <li>I'll confirm your appointment as soon as possible.</li>
        <li>I'll contact you once your appointment is confirmed.</li>
        <li>Keep your booking reference for future enquiries.</li>
      </ol>}
    </section>
    {bankTransfer && <details><summary>Bank transfer details</summary><BankDetails bank={bank} reference={booking.booking_payments.payment_reference} /></details>}
    <p><a href="https://vadmassage.com">Contact Vad</a></p>
  </>
}
