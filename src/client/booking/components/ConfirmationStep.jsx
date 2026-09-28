import { useEffect, useState } from 'react'
import { dateLabel, money, timeLabel } from '../bookingDraft.js'
import { BankDetails } from './PaymentStep.jsx'

export default function ConfirmationStep({ id, result, api, bank }) {
  const [view, setView] = useState({ booking: null, error: '', loading: true })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    api.booking(id).then((booking) => { if (live) setView({ booking, error: '', loading: false }) })
      .catch((error) => { if (live) setView({ booking: null, error: error.message, loading: false }) })
    return () => { live = false }
  }, [api, id, attempt])
  const booking = view.booking
  const payment = booking?.booking_payments
  return <>
    <h1>{booking || result ? 'Booking request received' : 'Retrieve your booking'}</h1>
    {result && !booking && <p>Booking reference: <strong>{result.booking_reference}</strong></p>}
    {view.loading && <p role="status">Loading your saved appointment…</p>}
    {view.error && <><p role="alert" className="error">{view.error}</p><button onClick={() => setAttempt(attempt + 1)}>Retry loading booking</button></>}
    {booking && <section className="panel">
      <p>Booking reference: <strong>{booking.booking_reference}</strong></p>
      <p>{dateLabel(booking.date)} at {timeLabel(booking.start_minutes)} (London time)</p>
      <p>{booking.service_area_name_snapshot} · {booking.address_line_1_snapshot}, {booking.city_snapshot}, {booking.postcode_snapshot}</p>
      <ol>{[...booking.booking_sessions].sort((a, b) => a.position - b.position).map((session) => <li key={session.position}>{session.service_name_snapshot} · {session.duration_minutes} minutes{session.recipient_name ? ` · ${session.recipient_name}` : ''}</li>)}</ol>
      <p>Total: <strong>{money(booking.total_gbp)}</strong></p>
      <p>Appointment: {booking.booking_status.replaceAll('_', ' ')}</p>
      <p>Payment: {payment.status.replaceAll('_', ' ')}</p>
      {payment.method === 'bank_transfer' && <><h2>Your bank transfer</h2><BankDetails bank={bank} /><p>Payment reference: <strong>{payment.payment_reference}</strong></p><p>Your transfer must be verified by Vad. This request does not mark your payment as paid.</p></>}
      {payment.method === 'cash' && <p>Vad will review your cash request before confirming your appointment.</p>}
    </section>}
    <p>For help with your appointment, <a href="https://vadmassage.com">contact Vad</a>.</p>
  </>
}
