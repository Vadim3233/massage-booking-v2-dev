import { useEffect, useRef, useState } from 'react'
import { clientName, dateLabel, label, money, sessionSummary, time } from './calendarPresentation.js'
import { loadReviewResource, paymentReviewApi } from './paymentReviewApi.js'
import PaymentActions from './PaymentActions.jsx'
export default function PaymentReview({ openBooking, revision }) {
  const [offset, setOffset] = useState(0)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const readVersion = useRef(0)
  useEffect(() => {
    let live = true
    const version = ++readVersion.current
    loadReviewResource(`queue:${offset}:${attempt}:${revision}`, () => paymentReviewApi.queue(offset)).then(data => { if (live && version === readVersion.current) { setResult({ offset, attempt, revision, ...data }); setError('') } }, () => { if (live && version === readVersion.current) setError('Could not load payment reviews. Please retry.') })
    return () => { live = false }
  }, [offset, attempt, revision])
  const current = result?.offset === offset && result?.attempt === attempt && result?.revision === revision ? result : null
  async function refresh() {
    const version = ++readVersion.current
    try { const data = await paymentReviewApi.queue(offset); if (version === readVersion.current) { setResult({ offset, attempt, revision, ...data }); setError('') } }
    catch (error) { if (version === readVersion.current) setError(error.message); throw error }
  }
  return <section className="admin-review" aria-labelledby="review-title">
    <header className="admin-review-heading"><div><h1 id="review-title">Payment review</h1><p>Transfers to verify and cash requests to decide.</p></div><button onClick={() => setAttempt(value => value + 1)} aria-label="Refresh reviews">↻</button></header>
    {error && <p role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>Retry reviews</button></p>}
    {!current && !error && <p role="status">Loading payment reviews…</p>}
    {current && <>
      {!current.bookings.length && <p>No payments awaiting review on this page.</p>}
      <ul className="admin-review-list">{current.bookings.map(booking => <li className="admin-review-item" key={booking.id}>
        <p className="admin-status pending">{booking.booking_payments.method === 'cash' ? 'Cash request to decide' : 'Bank transfer to verify'}</p>
        <div className="admin-card-heading"><h2>{clientName(booking)}</h2><strong className="admin-card-price">{money(booking.total_gbp)}</strong></div>
        <p>{dateLabel(booking.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} · {time(booking.start_minutes)}</p>
        <p>{sessionSummary(booking)}</p><p>{label(booking.booking_payments.method)} · {label(booking.booking_payments.status)}</p>
        <p className="admin-review-reference">{booking.booking_reference}</p>
        <a href={`/admin/bookings/${booking.id}`} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); openBooking(booking.id) } }}>View booking</a>
        <PaymentActions booking={booking} refresh={refresh} />
      </li>)}</ul>
      <div className="admin-payment-buttons" aria-label="Review pages"><button disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 50))}>Previous page</button><button disabled={!current.hasMore || offset >= 10000} onClick={() => setOffset(value => value + 50)}>Next page</button></div>
    </>}
  </section>
}
