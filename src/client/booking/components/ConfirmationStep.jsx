import { useEffect, useState } from 'react'
import Icon from '../../../ui/icons.jsx'
import BankDetails from './BankDetails.jsx'
import BookingSummary from './BookingSummary.jsx'
import { buildCalendarFile, calendarHref } from '../calendarFile.js'

export default function ConfirmationStep({ id, api, bank, again }) {
  const [view, setView] = useState({ booking: null, error: '' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    api.booking(id).then((booking) => { if (live) setView({ booking, error: '' }) })
      .catch((error) => { if (live) setView({ booking: null, error: error.message }) })
    return () => { live = false }
  }, [api, id, attempt])
  const booking = view.booking
  if (!booking) return <><h1 tabIndex={-1}>Retrieve your <em>booking</em></h1><p role="status">Loading your saved appointment…</p>{view.error && <><p role="alert" className="error">{view.error}</p><button onClick={() => setAttempt(attempt + 1)}>Retry loading booking</button></>}</>
  if (booking.booking_payments.status === 'awaiting_transfer') return <><h1 tabIndex={-1}>Your transfer has not been <em>declared</em></h1><p className="lede">Please return to Payment to complete your request.</p></>
  // Admin decisions must supersede the original pending-request instructions.
  const status = booking.booking_status
  const another = <button className="btn--tonal btn--block" onClick={again}>Book another appointment</button>
  if (['confirmed', 'completed', 'cancelled'].includes(status)) return <>
    <div className="success-mark" data-status={status} aria-hidden="true"><Icon name={status === 'cancelled' ? 'minus' : 'tick'} size={30} /></div>
    <h1 tabIndex={-1}>{status === 'cancelled' ? <>Your appointment is <em>cancelled</em></> : status === 'completed' ? <>Your appointment is <em>complete</em></> : <>Your appointment is <em>confirmed</em></>}</h1>
    <p className="lede">{status === 'cancelled' ? 'This appointment will not go ahead. Contact Vad if you have any questions.' : status === 'completed' ? 'Thank you for your visit.' : 'Your appointment has been confirmed.'}</p>
    <BookingSummary booking={booking} />
    {status === 'confirmed' && booking.booking_payments.method === 'cash' && booking.booking_payments.status === 'approved' && <p>Please pay the full amount in cash at your appointment.</p>}
    {status === 'confirmed' && <a className="btn btn--tonal btn--block" href={calendarHref(buildCalendarFile(booking))} download="massage-with-vad.ics"><Icon name="download" size={20} />Add to your calendar</a>}
    {another}
    <p className="fine"><a href={`/account?booking=${booking.id}`}>Manage this appointment</a> · <a href="https://vadmassage.com">Contact Vad</a></p>
  </>
  const bankTransfer = booking.booking_payments.method === 'bank_transfer'
  return <>
    <div className="success-mark" aria-hidden="true"><Icon name="tick" size={30} /></div>
    <h1 tabIndex={-1}>I've <em>received</em> your booking</h1>
    <p className="lede">{bankTransfer ? "Thank you. I look forward to seeing you. I'll check your transfer and confirm your appointment as soon as possible." : "Thank you. I look forward to seeing you. I'll confirm your appointment as soon as possible."}</p>
    <BookingSummary booking={booking} />
    <section><h2>What happens next</h2>
      {bankTransfer ? <ol className="timeline">
        <li>I'll check your transfer.</li>
        <li>I'll contact you once your appointment is confirmed.</li>
        <li>Keep your booking reference for future enquiries.</li>
      </ol> : <ol className="timeline">
        <li>I'll confirm your appointment as soon as possible.</li>
        <li>I'll contact you once your appointment is confirmed.</li>
        <li>Keep your booking reference for future enquiries.</li>
      </ol>}
    </section>
    {bankTransfer && <details className="more"><summary><span className="more-title">Bank transfer details</span></summary><div className="more-body"><BankDetails bank={bank} reference={booking.booking_payments.payment_reference} /></div></details>}
    {another}
    <p className="fine"><a href={`/account?booking=${booking.id}`}>Change or cancel this appointment</a> · <a href="https://vadmassage.com">Contact Vad</a></p>
  </>
}
