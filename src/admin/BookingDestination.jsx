import { useEffect, useRef, useState } from 'react'
import BookingDetails from './BookingDetails.jsx'
import BookingActions from './BookingActions.jsx'
import PaymentActions from './PaymentActions.jsx'
import { label } from './calendarPresentation.js'
import { loadReviewResource, paymentReviewApi } from './paymentReviewApi.js'
export default function BookingDestination({ id, close, changed, returnFocus }) {
  const [booking, setBooking] = useState(null)
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
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
  return <BookingDetails booking={booking} now={now} close={close} returnFocus={returnFocus} payment={<>
    <p>{label(booking.booking_payments?.method)} · {label(booking.booking_payments?.status)}</p>
    {error ? <p role="alert">{error}</p> : <PaymentActions booking={booking} refresh={refresh} />}
    <button onClick={() => setAttempt(value => value + 1)}>Refresh booking</button>
  </>} lifecycle={error ? null : <BookingActions booking={booking} refresh={refresh} />} />
}
