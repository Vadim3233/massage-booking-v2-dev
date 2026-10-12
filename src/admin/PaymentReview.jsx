import { useEffect, useRef, useState } from 'react'
import { clientName, dateLabel, label, money, sessionSummary, time } from './calendarPresentation.js'
import { loadReviewResource, paymentReviewApi } from './paymentReviewApi.js'
import PaymentActions from './PaymentActions.jsx'
import Icon from '../ui/icons.jsx'

const NEEDS_YOU = ['awaiting_verification', 'awaiting_approval']

function Item({ booking, openBooking, refresh }) {
  const needs = NEEDS_YOU.includes(booking.booking_payments.status)
  const cash = booking.booking_payments.method === 'cash'
  return <li className={`admin-review-item ${needs ? '' : 'wait'}`}>
    <p className={`chip ${needs ? 'chip--needs' : 'chip--wait'} admin-status pending`}>{cash ? 'Cash request to decide' : booking.booking_payments.status === 'awaiting_transfer' ? 'Transfer not yet declared by the client' : 'Bank transfer to verify'}</p>
    <div className="admin-card-heading"><h2>{clientName(booking)}</h2><strong className="admin-card-price">{money(booking.total_gbp)}</strong></div>
    <p className="admin-review-when">{dateLabel(booking.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} · {time(booking.start_minutes)} · {sessionSummary(booking)}</p>
    <p className="admin-review-reference">{label(booking.booking_payments.method)} · {label(booking.booking_payments.status)} · Booked {new Date(booking.created_at).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {booking.booking_reference}</p>
    <PaymentActions booking={booking} refresh={refresh} />
    <a href={`/admin/bookings/${booking.id}`} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); openBooking(booking.id) } }}>View booking <Icon name="right" size={18} /></a>
  </li>
}

export default function PaymentReview({ openBooking, revision }) {
  const [offset, setOffset] = useState(0)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const readVersion = useRef(0)
  useEffect(() => {
    let live = true
    const version = ++readVersion.current
    loadReviewResource(`queue:${offset}:${revision}`, () => paymentReviewApi.queue(offset), 3000).then(data => { if (live && version === readVersion.current) { setResult({ offset, attempt, revision, ...data }); setError('') } }, () => { if (live && version === readVersion.current) setError('Could not load payment reviews. Please retry.') })
    return () => { live = false }
  }, [offset, attempt, revision])
  const current = result?.offset === offset && result?.attempt === attempt && result?.revision === revision ? result : null
  async function refresh() {
    const version = ++readVersion.current
    try { const data = await paymentReviewApi.queue(offset); if (version === readVersion.current) { setResult({ offset, attempt, revision, ...data }); setError('') } }
    catch (error) { if (version === readVersion.current) setError(error.message); throw error }
  }
  const needs = current ? current.bookings.filter(booking => NEEDS_YOU.includes(booking.booking_payments.status)) : []
  const waiting = current ? current.bookings.filter(booking => !NEEDS_YOU.includes(booking.booking_payments.status)) : []
  const owed = needs.reduce((sum, booking) => sum + Number(booking.total_gbp), 0)
  // The list keeps the order the server gives, with the bookings that need the Admin first.
  const ordered = [...needs, ...waiting]
  return <section className="admin-review" aria-labelledby="review-title">
    <header className="admin-review-heading"><div><h1 id="review-title">To check</h1><p>Payments waiting for you. Confirm a payment, or cancel a booking you do not expect to be paid. Nothing is cancelled automatically.</p></div><button className="btn--quiet btn--icon" onClick={() => setAttempt(value => value + 1)} aria-label="Refresh reviews"><Icon name="refresh" size={22} /></button></header>
    {error && <p role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>Retry reviews</button></p>}
    {!current && !error && <div className="skeleton-rows" role="status"><span className="admin-sr-only">Loading payment reviews…</span><span className="skeleton" /><span className="skeleton" /></div>}
    {current && <>
      {!current.bookings.length && <p className="admin-agenda-empty"><strong>All caught up.</strong>No payments awaiting review on this page.</p>}
      {current.bookings.length > 0 && <p className="admin-review-summary"><strong>{needs.length} {needs.length === 1 ? 'needs' : 'need'} you</strong>{needs.length > 0 ? ` · ${money(owed)}` : ''}{waiting.length > 0 ? ` · ${waiting.length} waiting for the client` : ''}</p>}
      <ul role="list" className="admin-review-list">{ordered.map(booking => <Item key={booking.id} booking={booking} openBooking={openBooking} refresh={refresh} />)}</ul>
      <nav className="admin-payment-buttons" aria-label="Review pages"><button disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 50))}>Previous page</button><button disabled={!current.hasMore || offset >= 10000} onClick={() => setOffset(value => value + 50)}>Next page</button></nav>
    </>}
  </section>
}
