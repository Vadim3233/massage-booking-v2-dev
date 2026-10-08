import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useClientAuth } from '../auth/useClientAuth.js'
import AuthPanel from '../auth/AuthPanel.jsx'
import { dateLabel, londonDate, money, timeLabel } from '../booking/bookingDraft.js'
import BookingSummary from '../booking/components/BookingSummary.jsx'
import { accountApi } from './accountApi.js'
import { useBookingRules } from '../bookingRules.js'
import '../booking/booking.css'
import './account.css'

const STATUS_TEXT = {
  awaiting_transfer: 'Waiting for your bank transfer', awaiting_payment_verification: "Transfer sent — I'll check it shortly",
  awaiting_cash_approval: "Cash request — I'll confirm it soon", confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', no_show: 'Missed',
}
const OPEN = ['awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed']
const londonStamp = value => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value))

function Terms({ terms, action }) {
  if (!terms) return <p role="status">Checking your options…</p>
  if (!terms.can_change) return <p>This appointment can no longer be changed online. Please contact Vad.</p>
  const fee = Number(action === 'cancel' ? terms.cancel_fee_gbp : terms.reschedule_fee_gbp)
  return fee > 0
    ? <p className="account-note account-note--fee" role="status">This is inside {terms.free_cancellation_hours ?? 24} hours of your appointment, so a late fee of <strong>{money(fee)}</strong> applies. I can still make this change for you now.</p>
    : <p className="account-note" role="status">No charge. Changes are free until {londonStamp(terms.free_until)}.</p>
}

function CancelPanel({ booking, terms, done, back, refresh }) {
  const [reason, setReason] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef(null)
  const fee = Number(terms.cancel_fee_gbp)
  async function submit(event) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    const key = JSON.stringify([booking.id, fee, reason])
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    try { done(await accountApi.cancel(booking.id, request.current.id, fee, reason.trim())) }
    catch (failure) { setError(failure.message); if (failure.refresh) { setAgreed(false); refresh() } }
    finally { setBusy(false) }
  }
  return <form className="panel" onSubmit={submit}>
    <h2>Cancel this appointment?</h2>
    <Terms terms={terms} action="cancel" />
    <label>Anything you would like me to know? (optional)<textarea maxLength={500} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
    {fee > 0 && <label className="check"><input type="checkbox" checked={agreed} disabled={busy} onChange={event => setAgreed(event.target.checked)} />I understand a late fee of {money(fee)} will apply.</label>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="actions">
      <button type="button" disabled={busy} onClick={back}>Keep my appointment</button>
      <button type="submit" className="account-danger" disabled={busy || (fee > 0 && !agreed)}>{busy ? 'Cancelling…' : 'Cancel appointment'}</button>
    </div>
  </form>
}

function ReschedulePanel({ booking, terms, rules, done, back, refresh }) {
  const [date, setDate] = useState('')
  const [times, setTimes] = useState(null)
  const [start, setStart] = useState(null)
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef(null)
  const fee = Number(terms.reschedule_fee_gbp)
  useEffect(() => {
    if (!date) return undefined
    let live = true
    accountApi.availability(booking.id, date).then(list => { if (live) { setTimes(list); setStart(null); setError('') } }, failure => { if (live) { setTimes([]); setError(failure.message) } })
    return () => { live = false }
  }, [booking.id, date])
  async function submit(event) {
    event.preventDefault()
    if (busy || start === null) return
    setBusy(true); setError('')
    const key = JSON.stringify([booking.id, date, start, fee])
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    try { done(await accountApi.reschedule(booking.id, request.current.id, date, start, fee)) }
    catch (failure) { setError(failure.message); if (failure.refresh) { setAgreed(false); refresh() } }
    finally { setBusy(false) }
  }
  return <form className="panel" onSubmit={submit}>
    <h2>Choose a new time</h2>
    <Terms terms={terms} action="reschedule" />
    <label>New date<input type="date" required min={londonDate()} max={londonDate(rules.horizonDays)} value={date} disabled={busy} onChange={event => setDate(event.target.value)} /></label>
    {date && times === null && <p role="status">Looking for times…</p>}
    {times && !times.length && !error && <p>There are no times on that day. Please try another date.</p>}
    {times?.length > 0 && <div className="slots" role="group" aria-label="Available times">
      {times.map(minutes => <button type="button" key={minutes} aria-pressed={start === minutes} disabled={busy} onClick={() => setStart(minutes)}>{timeLabel(minutes)}</button>)}
    </div>}
    {fee > 0 && <label className="check"><input type="checkbox" checked={agreed} disabled={busy} onChange={event => setAgreed(event.target.checked)} />I understand a late fee of {money(fee)} will apply.</label>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="actions">
      <button type="button" disabled={busy} onClick={back}>Back</button>
      <button type="submit" className="primary account-inline" disabled={busy || start === null || (fee > 0 && !agreed)}>{busy ? 'Saving…' : 'Move my appointment'}</button>
    </div>
  </form>
}

function Manage({ id, rules, close, changed }) {
  const [booking, setBooking] = useState(null)
  const [terms, setTerms] = useState(null)
  const [mode, setMode] = useState('view')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const load = useCallback(() => setReload(value => value + 1), [])
  useEffect(() => {
    let live = true
    accountApi.booking(id).then(async fresh => {
      const next = OPEN.includes(fresh.booking_status) ? await accountApi.terms(id) : { can_change: false }
      if (live) { setBooking(fresh); setTerms(next); setError('') }
    }).catch(failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [id, reload])
  function done(result, text) {
    setMode('view'); setMessage(result ? text : '')
    load(); changed()
  }
  if (!booking) return <section className="panel">{error ? <><p role="alert" className="error">{error}</p><button onClick={load}>Try again</button></> : <p role="status">Loading your appointment…</p>}<button onClick={close}>Back to your bookings</button></section>
  const open = OPEN.includes(booking.booking_status)
  const owes = Number(booking.late_fee_due_gbp) > 0 && booking.late_fee_status === 'due'
  return <section>
    <button className="account-back" onClick={close}>← Your bookings</button>
    <h1>{STATUS_TEXT[booking.booking_status]}</h1>
    {message && <p role="status" className="account-note">{message}</p>}
    {mode === 'view' && <>
      <BookingSummary booking={booking} />
      {owes && <p className="account-note account-note--fee">A late fee of {money(booking.late_fee_due_gbp)} is due for this appointment. I will be in touch about it.</p>}
      {booking.booking_status === 'cancelled' && Number(booking.refund_due_gbp) > 0 && <p className="account-note">A refund of {money(booking.refund_due_gbp)} is on its way to you.</p>}
      {open && terms?.can_change && <>
        <Terms terms={terms} action="reschedule" />
        <div className="actions"><button onClick={() => setMode('reschedule')}>Change the time</button><button onClick={() => setMode('cancel')}>Cancel appointment</button></div>
      </>}
      {open && terms && !terms.can_change && <p>This appointment can no longer be changed online. Please contact Vad.</p>}
    </>}
    {mode === 'cancel' && terms && <CancelPanel booking={booking} terms={terms} back={() => setMode('view')} refresh={load} done={result => done(result, 'Your appointment is cancelled.')} />}
    {mode === 'reschedule' && terms && <ReschedulePanel booking={booking} terms={terms} rules={rules} back={() => setMode('view')} refresh={load} done={result => done(result, 'Your appointment has been moved.')} />}
    <p><a href="https://vadmassage.com">Contact Vad</a></p>
  </section>
}

function BookingList({ open }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    accountApi.list().then(list => { if (live) { setRows(list); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [attempt])
  if (error) return <><p role="alert" className="error">{error}</p><button onClick={() => setAttempt(value => value + 1)}>Try again</button></>
  if (!rows) return <p role="status">Loading your bookings…</p>
  const today = londonDate()
  const upcoming = rows.filter(row => OPEN.includes(row.booking_status) && row.date >= today).reverse()
  const earlier = rows.filter(row => !upcoming.includes(row))
  const item = row => <li key={row.id}>
    <button className="account-booking" onClick={() => open(row.id)}>
      <span className="account-when">{dateLabel(row.date)} · {timeLabel(row.start_minutes)}</span>
      <span className="account-what">{row.services || 'Massage'} · {row.treatment_duration_minutes} min</span>
      <span className={`account-status account-status--${row.booking_status}`}>{STATUS_TEXT[row.booking_status]}</span>
    </button>
  </li>
  return <>
    <h2>Coming up</h2>
    {upcoming.length ? <ul className="account-list">{upcoming.map(item)}</ul> : <p>You have no upcoming appointments. <a href="/">Book a treatment</a></p>}
    {earlier.length > 0 && <><h2>Earlier</h2><ul className="account-list">{earlier.map(item)}</ul></>}
  </>
}

export default function AccountApp() {
  useEffect(() => { const previous = document.title; document.title = 'Your bookings · VadMassage'; return () => { document.title = previous } }, [])
  const auth = useClientAuth(supabase)
  const [selected, setSelected] = useState(() => new URLSearchParams(window.location.search).get('booking'))
  const [revision, setRevision] = useState(0)
  const rules = useBookingRules(supabase)
  function select(id) {
    setSelected(id)
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('booking', id); else url.searchParams.delete('booking')
    window.history.replaceState(null, '', url)
  }
  return <main className="booking-shell">
    <header className="brand"><a href="/"><b className="brand-mark" aria-hidden="true">VM</b>VadMassage</a><span>Your bookings</span></header>
    {!auth.ready && <p role="status">Checking your account…</p>}
    {auth.ready && !auth.session && <AuthPanel client={supabase} heading="Sign in to see your bookings" redirectTo={`${window.location.origin}/account`} />}
    {auth.ready && auth.session && (selected
      ? <Manage key={selected} id={selected} rules={rules} close={() => select(null)} changed={() => setRevision(value => value + 1)} />
      : <><h1>Your bookings</h1><BookingList key={revision} open={select} /></>)}
    <footer>Personal treatments, thoughtfully arranged. <a href="https://vadmassage.com">Contact Vad</a></footer>
  </main>
}
