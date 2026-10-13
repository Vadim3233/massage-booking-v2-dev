import { useEffect, useRef, useState } from 'react'
import BookingDetails from './BookingDetails.jsx'
import BookingActions from './BookingActions.jsx'
import PaymentActions from './PaymentActions.jsx'
import ReceiptPanel, { ReceiptNote } from './ReceiptPanel.jsx'
import { label } from './calendarPresentation.js'
import { loadReviewResource, paymentReviewApi } from './paymentReviewApi.js'
export default function BookingDestination({ id, close, changed, returnFocus, openPage }) {
  const [booking, setBooking] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const readVersion = useRef(0)
  useEffect(() => {
    let live = true
    const version = ++readVersion.current
    loadReviewResource(`booking:${id}:${attempt}`, () => paymentReviewApi.booking(id)).then(data => { if (live && version === readVersion.current) { setBooking(data); setError('') } }, error => { if (live && version === readVersion.current) setError(error.message) })
    return () => { live = false }
  }, [id, attempt])
  async function refresh() {
    const version = ++readVersion.current
    changed()
    try { const current = await paymentReviewApi.booking(id); if (version === readVersion.current) { setBooking(current); setError('') } }
    catch (error) { if (version === readVersion.current) setError('Could not load the current booking. Refresh before another action.'); throw error }
  }
  if (!booking) return <section className="admin-review">{error ? <p role="alert">{error}</p> : <p role="status">Loading booking…</p>}<button onClick={() => setAttempt(value => value + 1)}>Retry booking</button><button onClick={close}>Back to Calendar</button></section>
  // Once the money has been received on a confirmed or completed booking there is a receipt to send. A booking that was cancelled, marked as
  // missed, or whose payment was refunded cannot have one made or sent, but a receipt made earlier is shown as a note.
  const canHaveReceipt = booking.booking_payments?.status === 'paid' && ['confirmed', 'completed'].includes(booking.booking_status)
  const receiptClosed = ['cancelled', 'no_show'].includes(booking.booking_status) || booking.booking_payments?.status === 'refunded'
  return <BookingDetails booking={booking} close={close} returnFocus={returnFocus} payment={<>
    <p className="admin-next-status">{label(booking.booking_payments?.method)} · {label(booking.booking_payments?.status)}</p>
    {error ? <p role="alert">{error}</p> : <PaymentActions booking={booking} refresh={refresh} />}
    {!error && canHaveReceipt && <ReceiptPanel key={booking.id} booking={booking} openPage={openPage} />}
    {!error && !canHaveReceipt && receiptClosed && <ReceiptNote key={booking.id} booking={booking} />}
    <button className="btn--quiet btn--small" onClick={() => setAttempt(value => value + 1)}>Check for changes</button>
  </>} lifecycle={error ? null : <BookingActions booking={booking} refresh={refresh} />} />
}
