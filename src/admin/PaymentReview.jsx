import { useCallback, useEffect, useRef, useState } from 'react'
import { clientName, money, sessionSummary, time } from './calendarPresentation.js'
import { groupByAppointmentDay } from './reviewDays.js'
import { loadReviewResource, needsYou, paymentReviewApi } from './paymentReviewApi.js'
import { activeReminder, reminderWhen, useReminders } from './paymentReminders.js'
import PaymentActions from './PaymentActions.jsx'
import { useQuietRetry, useReturnRefresh } from './useReturnRefresh.js'
import Icon from '../ui/icons.jsx'

// `reminder` is set when the Admin has put this payment off with "Not yet"; it then waits quietly, like one the client has not declared yet.
function Item({ booking, openBooking, refresh, reminder }) {
  const needs = needsYou(booking) && !reminder
  const cash = booking.booking_payments.method === 'cash'
  return <li className={`admin-review-item ${needs ? '' : 'wait'}`} data-variant="sand">
    <p className={`chip ${needs ? 'chip--needs' : 'chip--wait'} admin-status pending`}>{reminder ? `Reminder set · back ${reminderWhen(reminder.until)}` : cash ? 'Cash request to decide' : booking.booking_payments.status === 'awaiting_transfer' ? 'Transfer not yet declared by the client' : 'Bank transfer to verify'}</p>
    <div className="admin-card-heading"><h3>{clientName(booking)}</h3><strong className="admin-card-price">{money(booking.total_gbp)}</strong></div>
    <p className="admin-review-when">{time(booking.start_minutes)} · {sessionSummary(booking)}</p>
    <p className="admin-review-reference">Booked {new Date(booking.created_at).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {booking.booking_reference}</p>
    <PaymentActions booking={booking} refresh={refresh} short later />
    <a href={`/admin/bookings/${booking.id}`} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); openBooking(booking.id) } }}>View booking <Icon name="right" size={18} /></a>
  </li>
}

export default function PaymentReview({ openBooking, revision, changed }) {
  const [offset, setOffset] = useState(0)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const readVersion = useRef(0)
  const shownOffset = useRef(null)
  const reread = useCallback(() => setAttempt(value => value + 1), [])
  const quiet = useQuietRetry(reread)
  // A reminder that has come due is noticed within half a minute.
  const reminders = useReminders()
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const clock = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(clock) }, [])
  useEffect(() => {
    let live = true
    const version = ++readVersion.current
    loadReviewResource(`queue:${offset}:${revision}`, () => paymentReviewApi.queue(offset), 3000).then(data => {
      if (!live || version !== readVersion.current) return
      shownOffset.current = offset
      quiet.succeeded()
      setResult({ offset, ...data })
      setError('')
    }, () => {
      if (!live || version !== readVersion.current) return
      // A page already on screen that cannot be refreshed just now is tried once more, quietly, before anyone is told.
      if (shownOffset.current === offset && quiet.failed()) return
      setError('Could not load payment reviews. Please retry.')
    })
    return () => { live = false }
  }, [offset, attempt, revision, quiet])
  useReturnRefresh(reread)
  // The page on show stays while it is read again.
  const current = result?.offset === offset ? result : null
  async function refresh() {
    const version = ++readVersion.current
    try { const data = await paymentReviewApi.queue(offset); if (version === readVersion.current) { setResult({ offset, ...data }); setError('') } changed?.() }
    catch (error) { if (version === readVersion.current) setError(error.message); throw error }
  }
  const putOff = booking => (needsYou(booking) ? activeReminder(booking, reminders, now) : null)
  const needs = current ? current.bookings.filter(booking => needsYou(booking) && !putOff(booking)) : []
  const reminded = current ? current.bookings.filter(putOff) : []
  const waiting = current ? current.bookings.filter(booking => !needsYou(booking)) : []
  const owed = needs.reduce((sum, booking) => sum + Number(booking.total_gbp), 0)
  // The appointment's day is the heading above its card, soonest first.
  const days = current ? groupByAppointmentDay(current.bookings, booking => needsYou(booking) && !putOff(booking)) : []
  return <section className="admin-review" aria-labelledby="review-title">
    <header className="admin-review-heading"><div><h1 id="review-title">To check</h1><p>Confirm a payment when it arrives, or cancel a booking that will not be paid. Nothing is cancelled automatically.</p></div><button className="btn--quiet btn--icon" onClick={() => { quiet.asked(); reread() }} aria-label="Refresh reviews"><Icon name="refresh" size={22} /></button></header>
    {error && <p role={result ? 'status' : 'alert'}>{error} <button onClick={() => { quiet.asked(); reread() }}>Retry reviews</button></p>}
    {!current && !error && <div className="skeleton-rows" role="status"><span className="admin-sr-only">Loading payment reviews…</span><span className="skeleton" /><span className="skeleton" /></div>}
    {current && <>
      {!current.bookings.length && <p className="admin-agenda-empty"><strong>All caught up.</strong>No payments awaiting review on this page.</p>}
      {current.bookings.length > 0 && <p className="admin-review-summary"><strong>{needs.length} {needs.length === 1 ? 'needs' : 'need'} you</strong>{needs.length > 0 ? ` · ${money(owed)}` : ''}{reminded.length > 0 ? ` · ${reminded.length} ${reminded.length === 1 ? 'reminder' : 'reminders'} set` : ''}{waiting.length > 0 ? ` · ${waiting.length} waiting for the client` : ''}</p>}
      {days.map(day => <section key={day.date} className={`admin-review-day ${day.name === 'Today' ? 'is-today' : ''}`} aria-labelledby={`review-${day.date}`}>
        <header className="admin-agenda-day-heading">
          <h2 id={`review-${day.date}`}><span className="day-name">{day.name}</span>{day.rest ? ` · ${day.rest}` : ''}</h2>
          <span>{day.needs > 0 ? `${day.needs} ${day.needs === 1 ? 'needs' : 'need'} you · ${money(day.owed)}` : day.items.some(putOff) ? 'reminder set' : 'waiting for the client'}</span>
        </header>
        <ul role="list" className="admin-review-list">{day.items.map(booking => <Item key={booking.id} booking={booking} openBooking={openBooking} refresh={refresh} reminder={putOff(booking)} />)}</ul>
      </section>)}
      {(offset > 0 || current.hasMore) && <nav className="admin-payment-buttons" aria-label="Review pages"><button disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 50))}>Previous page</button><button disabled={!current.hasMore || offset >= 10000} onClick={() => setOffset(value => value + 50)}>Next page</button></nav>}
    </>}
  </section>
}
