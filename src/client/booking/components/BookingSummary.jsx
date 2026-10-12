import { dateLabel, money, timeLabel } from '../bookingDraft.js'
import { formatPostcode, paymentStatus } from '../paymentPresentation.js'
import { CopyValue } from './BankDetails.jsx'

export default function BookingSummary({ booking, paymentLabel }) {
  const endMinutes = booking.start_minutes + booking.treatment_duration_minutes
  return <section className="panel ticket ticket--summary" aria-label="Appointment summary">
    <dl className="prices bank-list"><CopyValue label="Booking reference" value={booking.booking_reference} /></dl>
    <p className="summary-when">{dateLabel(booking.date)} · {timeLabel(booking.start_minutes)}–{timeLabel(endMinutes)} (London time)</p>
    <p className="summary-line">{booking.treatment_duration_minutes} minutes in total</p>
    <p className="summary-line">{[booking.address_line_1_snapshot, booking.address_line_2_snapshot, booking.city_snapshot, formatPostcode(booking.postcode_snapshot)].filter(Boolean).join(', ')}</p>
    <p className="summary-line">Confirmation email: <strong>{booking.booking_email_snapshot || 'Please contact Vad to confirm your email'}</strong></p>
    <ol className="summary-sessions">{booking.booking_sessions.map((session) => <li key={session.position}>{session.service_name_snapshot} · {session.duration_minutes} minutes{session.recipient_name ? ` · ${session.recipient_name}` : ''}</li>)}</ol>
    <p className="summary-total">Total: <strong className="figure">{money(booking.total_gbp)}</strong></p>
    <p className="summary-line">Payment: {paymentLabel || paymentStatus(booking)}</p>
  </section>
}
