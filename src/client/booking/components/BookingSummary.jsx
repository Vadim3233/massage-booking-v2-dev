import { dateLabel, money, timeLabel } from '../bookingDraft.js'
import { formatPostcode, paymentStatus } from '../paymentPresentation.js'
import { CopyValue } from './BankDetails.jsx'

export default function BookingSummary({ booking, paymentLabel }) {
  const endMinutes = booking.start_minutes + booking.treatment_duration_minutes
  return <section className="panel" aria-label="Appointment summary">
    <dl className="prices"><CopyValue label="Booking reference" value={booking.booking_reference} /></dl>
    <p>{dateLabel(booking.date)} · {timeLabel(booking.start_minutes)}–{timeLabel(endMinutes)} (London time)</p>
    <p>{booking.treatment_duration_minutes} minutes in total</p>
    <p>{[booking.address_line_1_snapshot, booking.address_line_2_snapshot, booking.city_snapshot, formatPostcode(booking.postcode_snapshot)].filter(Boolean).join(', ')}</p>
    <p>Confirmation email: <strong>{booking.booking_email_snapshot || 'Please contact Vad to confirm your email'}</strong></p>
    <ol>{booking.booking_sessions.map((session) => <li key={session.position}>{session.service_name_snapshot} · {session.duration_minutes} minutes{session.recipient_name ? ` · ${session.recipient_name}` : ''}</li>)}</ol>
    <p>Total: <strong>{money(booking.total_gbp)}</strong></p>
    <p>Payment: {paymentLabel || paymentStatus(booking)}</p>
  </section>
}
