import { dateLabel, money, timeLabel } from '../bookingDraft.js'
import { EMAIL_SENDER } from '../../emailSender.js'
import { paymentStatus } from '../paymentPresentation.js'
import { CopyValue } from './BankDetails.jsx'
import { PriceSummary } from './ReviewStep.jsx'

// `emailHint` adds, under the address, where my emails come from and where to look for one that has not come. The payment step leaves it out: no email has gone yet.
export default function BookingSummary({ booking, paymentLabel, quote, emailHint }) {
  const endMinutes = booking.start_minutes + booking.treatment_duration_minutes
  // The price with its parts, when something besides the treatments is in it (extras, travel) and the choices that made it are still to hand.
  const parts = quote && Math.abs(Number(quote.total_gbp) - Number(booking.total_gbp)) < 0.005
    && ['enhancements_total_gbp', 'travel_fee_gbp', 'congestion_fee_gbp'].some((key) => Number(quote[key]) > 0)
  return <section className="panel ticket ticket--summary" aria-label="Appointment summary">
    <dl className="prices bank-list"><CopyValue label="Booking reference" value={booking.booking_reference} /></dl>
    <p className="summary-when">{dateLabel(booking.date)} · {timeLabel(booking.start_minutes)}–{timeLabel(endMinutes)} (London time)</p>
    <p className="summary-line">{booking.treatment_duration_minutes} minutes in total</p>
    <p className="summary-line">{booking.address_snapshot}</p>
    <p className="summary-line">Confirmation email: <strong>{booking.booking_email_snapshot || 'Please contact Vad to confirm your email'}</strong></p>
    {/* A new sender's first email can land in spam, and one "Not spam" teaches the inbox. */}
    {emailHint && booking.booking_email_snapshot && <p className="summary-hint">My emails come from <strong>{EMAIL_SENDER}</strong>. Can't find one? Look in your spam folder and press “Not spam”.</p>}
    <ol className="summary-sessions">{booking.booking_sessions.map((session) => <li key={session.position}>{session.service_name_snapshot} · {session.duration_minutes} minutes{session.recipient_name ? ` · ${session.recipient_name}` : ''}</li>)}</ol>
    {parts ? <PriceSummary quote={quote} /> : <p className="summary-total">Total: <strong className="figure">{money(booking.total_gbp)}</strong></p>}
    <p className="summary-line">Payment: {paymentLabel || paymentStatus(booking)}</p>
  </section>
}
