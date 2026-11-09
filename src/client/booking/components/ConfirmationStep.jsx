import { useEffect, useMemo, useState } from 'react'
import DrawnTick from './DrawnTick.jsx'
import Icon from '../../../ui/icons.jsx'
import BankDetails from './BankDetails.jsx'
import BookingSummary from './BookingSummary.jsx'
import TelegramBox from './TelegramBox.jsx'
import { buildCalendarFile, calendarHref } from '../calendarFile.js'
import { friendlyError } from '../friendlyError.js'
import { money } from '../bookingDraft.js'
import { shortDay } from '../payAfter.js'

// After a booking: the offer to book the next sessions now, with the rule that each is paid for after the one before (ADR-097).
function AnotherSession({ again }) {
  return <section className="another-session" aria-labelledby="another-title">
    <h2 id="another-title">Want to book your next sessions too?</h2>
    <p>You can book as many as you like now. You only pay for the next one. Pay for each later session after the one before it.</p>
    <button className="btn--primary btn--block" onClick={() => again(true)}>Book another session</button>
    <p className="fine">Same treatment and length. You just pick the time.</p>
  </section>
}

export default function ConfirmationStep({ id, api, bank, quote, again }) {
  const [view, setView] = useState({ booking: null, error: '' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    api.booking(id).then((booking) => { if (live) setView({ booking, error: '' }) })
      .catch((error) => { if (live) setView({ booking: null, error: friendlyError(error) }) })
    return () => { live = false }
  }, [api, id, attempt])
  const booking = view.booking
  // The page starts on "Retrieve your booking" and becomes the confirmation: its heading is read out again when it does.
  useEffect(() => { if (booking) document.querySelector('.booking-main h1')?.focus({ preventScroll: true }) }, [booking?.id, booking?.booking_status]) // eslint-disable-line react-hooks/exhaustive-deps
  // Built once per booking, so the link does not change under a finger every time the page redraws.
  const calendar = useMemo(() => (booking?.booking_status === 'confirmed' ? calendarHref(buildCalendarFile(booking, new Date(), window.location.origin)) : null), [booking])
  if (!booking) return <><h1 tabIndex={-1}>Retrieve your <em>booking</em></h1><p role="status">Loading your saved appointment…</p>{view.error && <><p role="alert" className="error">{view.error}</p><button onClick={() => setAttempt(attempt + 1)}>Retry loading booking</button></>}</>
  // A later session, paid after the client's earlier one (ADR-097): its payment stays open, and there is nothing to pay yet.
  const after = booking.pay_after_session
  const laterNote = after && booking.booking_payments.status === 'awaiting_transfer' && <p className="pay-after-note">Nothing to pay yet. After your {shortDay(after.date)} session, I'll send you the details to pay {money(booking.total_gbp)} for this one.</p>
  if (booking.booking_payments.status === 'awaiting_transfer' && !after) return <><h1 tabIndex={-1}>One more <em>step</em></h1><p className="lede">I haven't heard that your transfer is made yet. Please go back to the payment step.</p></>
  // Admin decisions must supersede the original pending-request instructions.
  const status = booking.booking_status
  const another = status === 'cancelled' ? <button className="btn--tonal btn--block" onClick={() => again()}>Book another appointment</button> : <AnotherSession again={again} />
  if (['confirmed', 'completed', 'cancelled'].includes(status)) return <>
    {status === 'cancelled' ? <div className="success-mark" data-status={status} aria-hidden="true"><Icon name="minus" size={30} /></div> : <DrawnTick />}
    <h1 tabIndex={-1}>{status === 'cancelled' ? <>Your appointment is <em>cancelled</em></> : status === 'completed' ? <>Your appointment is <em>complete</em></> : <>Your appointment is <em>confirmed</em></>}</h1>
    <p className="lede">{status === 'cancelled' ? 'This appointment will not go ahead. Contact Vadim if you have any questions.' : status === 'completed' ? 'Thank you for your visit.' : "I'm looking forward to seeing you."}</p>
    {status === 'confirmed' && laterNote}
    {status === 'confirmed' && <TelegramBox />}
    <BookingSummary booking={booking} quote={quote} emailHint />
    {status === 'confirmed' && booking.booking_payments.method === 'cash' && booking.booking_payments.status === 'approved' && <p>Please pay the full amount in cash at your appointment.</p>}
    {calendar && <a className="btn btn--tonal btn--block" href={calendar} download="massage-with-vad.ics"><Icon name="download" size={20} />Add to your calendar</a>}
    {another}
    {status === 'confirmed' && <a className="btn btn--quiet btn--block" href={`/account?booking=${booking.id}`}>Manage this appointment</a>}
    <p className="fine"><a href="https://vadmassage.com">Contact Vadim</a></p>
  </>
  const bankTransfer = booking.booking_payments.method === 'bank_transfer'
  // A later session not confirmed yet: it is confirmed with the earlier one (or by Vadim, with the switch off), and nothing is paid yet.
  if (after) return <>
    <DrawnTick />
    <h1 tabIndex={-1}>I've <em>received</em> your booking</h1>
    <p className="lede">{after.auto_confirm === false ? "Thank you. I'll look at it and confirm it as soon as possible." : `Thank you. It's confirmed as soon as your ${shortDay(after.date)} session is, and I'll let you know.`}</p>
    {laterNote}
    <TelegramBox />
    <BookingSummary booking={booking} quote={quote} emailHint />
    {another}
    <a className="btn btn--quiet btn--block" href={`/account?booking=${booking.id}`}>Change or cancel this appointment</a>
    <p className="fine"><a href="https://vadmassage.com">Contact Vadim</a></p>
  </>
  return <>
    <DrawnTick />
    <h1 tabIndex={-1}>I've <em>received</em> your booking</h1>
    <p className="lede">{bankTransfer ? "Thank you. I look forward to seeing you. I'll check your transfer and confirm your appointment as soon as possible." : "Thank you. I look forward to seeing you. I'll confirm your appointment as soon as possible."}</p>
    <TelegramBox />
    <BookingSummary booking={booking} quote={quote} emailHint />
    <section><h2>What happens next</h2>
      {bankTransfer ? <ol role="list" className="timeline">
        <li>I'll check your transfer.</li>
        <li>I'll contact you once your appointment is confirmed.</li>
        <li>Keep your booking reference for future enquiries.</li>
      </ol> : <ol role="list" className="timeline">
        <li>I'll look at your request and confirm your appointment as soon as possible.</li>
        <li>I'll contact you once your appointment is confirmed.</li>
        <li>Keep your booking reference for future enquiries.</li>
      </ol>}
    </section>
    {bankTransfer && <details className="more"><summary><span className="more-title">Bank transfer details</span></summary><div className="more-body"><BankDetails bank={bank} reference={booking.booking_payments.payment_reference} /></div></details>}
    {another}
    <a className="btn btn--quiet btn--block" href={`/account?booking=${booking.id}`}>Change or cancel this appointment</a>
    <p className="fine"><a href="https://vadmassage.com">Contact Vadim</a></p>
  </>
}
