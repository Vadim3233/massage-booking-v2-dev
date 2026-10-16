import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { dayParts } from '../booking/dateStrip.js'
import Icon from '../../ui/icons.jsx'
import { supabase } from '../../lib/supabase.js'
import { useClientAuth } from '../auth/useClientAuth.js'
import { useLinkProblem } from '../auth/linkProblem.js'
import AuthPanel from '../auth/AuthPanel.jsx'
import { dateLabel, londonDate, money, timeLabel } from '../booking/bookingDraft.js'
import DayTimePicker from '../booking/components/DayTimePicker.jsx'
import BookingSummary from '../booking/components/BookingSummary.jsx'
import TelegramBox from '../booking/components/TelegramBox.jsx'
import { accountApi, createAccountApi, LINK_INVALID } from './accountApi.js'
import { cancelledOn } from './cancelledOn.js'
import { useBookingRules } from '../bookingRules.js'
import '../booking/booking.css'
import './account.css'

const STATUS_TEXT = {
  awaiting_transfer: 'Waiting for your bank transfer', awaiting_payment_verification: "Transfer sent — I'll check it shortly",
  awaiting_cash_approval: "Cash request — I'll confirm it soon", confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', no_show: 'Missed',
}
const CHIP = {
  awaiting_transfer: 'needs', awaiting_payment_verification: 'wait', awaiting_cash_approval: 'wait', confirmed: 'ok', completed: 'done', cancelled: 'cancel', no_show: 'noshow',
}
const HEADING = { ...STATUS_TEXT, confirmed: 'Your appointment is confirmed', completed: 'Your appointment is complete', cancelled: 'Your appointment is cancelled', no_show: 'This appointment was missed' }
const OPEN = ['awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed']
const londonStamp = value => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value))

// The private link in a booking email is /account?booking=<id>#key=<code>. The code is kept for this tab only (so a reload still works)
// and is taken out of the address bar, so a copied address or a screenshot does not carry it.
const keptCode = id => `vad-booking-link:${id}`
function readLink() {
  const booking = new URLSearchParams(window.location.search).get('booking')
  if (!booking) return { booking: null, key: '' }
  // A mail app can add a full stop or a bracket after an address it shows as text, so only the letters and digits of a code count.
  let key = (new URLSearchParams(window.location.hash.replace(/^#/, '')).get('key') || '').match(/^[0-9a-f]*/)[0]
  if (!key) { try { key = sessionStorage.getItem(keptCode(booking)) || '' } catch { /* Storage can be unavailable. */ } }
  return { booking, key }
}

// "Massage, Massage" reads better as "Massage × 2".
function servicesLabel(text) {
  const counts = new Map()
  for (const name of String(text || 'Massage').split(', ')) counts.set(name, (counts.get(name) || 0) + 1)
  return [...counts].map(([name, count]) => (count > 1 ? `${name} × ${count}` : name)).join(', ')
}

function Terms({ terms, action }) {
  if (!terms) return <p role="status">Checking your options…</p>
  if (!terms.can_change) return <p>This appointment can no longer be changed online. Please contact Vad.</p>
  const fee = Number(action === 'cancel' ? terms.cancel_fee_gbp : terms.reschedule_fee_gbp)
  return fee > 0
    ? <p className="account-note account-note--fee" role="status">This is inside {terms.free_cancellation_hours ?? 24} hours of your appointment, so a late fee of <strong>{money(fee)}</strong> applies. I can still make this change for you now.</p>
    : <p className="account-note" role="status">No charge. Changes are free until {londonStamp(terms.free_until)}.</p>
}

function CancelPanel({ booking, terms, done, back, refresh, api }) {
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
    try { done(await api.cancel(booking.id, request.current.id, fee, reason.trim())) }
    catch (failure) { setError(failure.message); if (failure.refresh) { setAgreed(false); refresh() } }
    finally { setBusy(false) }
  }
  return <form className="panel" onSubmit={submit}>
    <h2 tabIndex={-1}>Cancel this appointment?</h2>
    <Terms terms={terms} action="cancel" />
    <label>Anything you would like me to know? (optional)<textarea maxLength={500} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
    {fee > 0 && <label className="check"><input type="checkbox" checked={agreed} disabled={busy} onChange={event => setAgreed(event.target.checked)} />I understand a late fee of {money(fee)} will apply.</label>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="actions">
      <button type="button" className="btn--primary" disabled={busy} onClick={back}>Keep my appointment</button>
      <button type="submit" className="btn--danger" disabled={busy || (fee > 0 && !agreed)}>{busy ? 'Cancelling…' : 'Cancel appointment'}</button>
    </div>
  </form>
}

function ReschedulePanel({ booking, terms, rules, done, back, refresh, api }) {
  const [chosen, setChosen] = useState(null)
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef(null)
  const fee = Number(terms.reschedule_fee_gbp)
  async function submit(event) {
    event.preventDefault()
    if (busy || !chosen || (fee > 0 && !agreed)) return
    setBusy(true); setError('')
    const key = JSON.stringify([booking.id, chosen.date, chosen.start, fee])
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    try { done(await api.reschedule(booking.id, request.current.id, chosen.date, chosen.start, fee)) }
    catch (failure) { setError(failure.message); if (failure.refresh) { setAgreed(false); refresh() } }
    finally { setBusy(false) }
  }
  return <form className="panel" onSubmit={submit}>
    <h2 tabIndex={-1}>Choose a new time</h2>
    <Terms terms={terms} action="reschedule" />
    <DayTimePicker key={booking.id} horizonDays={rules.horizonDays} dateLabel="New date" loadDay={(date) => api.availability(booking.id, date)}
      selected={chosen} onPick={(date, start) => { setChosen({ date, start }); setError('') }} emptyMessage="There are no times on that day. Please try another date." />
    {chosen && <p className="account-note" role="status">New time: <strong>{dayParts(chosen.date).long}, {timeLabel(chosen.start)}–{timeLabel(chosen.start + booking.treatment_duration_minutes)}</strong></p>}
    {fee > 0 && <label className="check"><input type="checkbox" checked={agreed} disabled={busy} onChange={event => setAgreed(event.target.checked)} />I understand a late fee of {money(fee)} will apply.</label>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="actions">
      <button type="button" disabled={busy} onClick={back}>Back</button>
      <button type="submit" className="btn--primary" disabled={busy || !chosen || (fee > 0 && !agreed)}>{busy ? 'Saving…' : 'Move my appointment'}</button>
    </div>
  </form>
}

// One booking, with what can be done to it. `linked` means it was opened from the private link in an email, with no sign-in: there is
// no list of other bookings to go back to then.
function Manage({ id, rules, close, changed, api, linked = false }) {
  const [booking, setBooking] = useState(null)
  const [terms, setTerms] = useState(null)
  const [mode, setMode] = useState('view')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  // Opening the cancel or change form, and coming back from it, moves the reader to what is now on screen.
  const shown = useRef(false)
  useEffect(() => {
    if (shown.current) setTimeout(() => document.querySelector(mode === 'view' ? '.booking-main h1' : '.booking-main form h2')?.focus({ preventScroll: true }), 0)
    shown.current = true
  }, [mode])
  const load = useCallback(() => setReload(value => value + 1), [])
  useEffect(() => {
    let live = true
    api.booking(id).then(async fresh => {
      const next = OPEN.includes(fresh.booking_status) ? await api.terms(id) : { can_change: false }
      if (live) { setBooking(fresh); setTerms(next); setError('') }
    }).catch(failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, id, reload])
  function done(result, text) {
    setMode('view'); setMessage(result ? text : '')
    load(); changed()
  }
  const signIn = linked && <p className="fine">If you have an account, you can <a href="/account">sign in</a> to see all your bookings.</p>
  if (!booking) return <>
    <h1 tabIndex={-1}>Your <em>appointment</em></h1>
    <section className="panel">
      {error ? <><p role="alert" className="error">{error}</p>{error !== LINK_INVALID && <button onClick={load}>Try again</button>}</> : <p role="status">Loading your appointment…</p>}
      {linked ? <p><a href="https://vadmassage.com">Contact Vad</a></p> : <button onClick={close}>Back to your bookings</button>}
    </section>
    {error && signIn}
  </>
  const open = OPEN.includes(booking.booking_status)
  const owes = Number(booking.late_fee_due_gbp) > 0 && booking.late_fee_status === 'due'
  const cancelledAt = cancelledOn(booking.cancelled_at)
  return <section>
    {!linked && <button className="btn--quiet btn--small account-back" onClick={close}><Icon name="left" size={20} />Your bookings</button>}
    <h1 tabIndex={-1}>{HEADING[booking.booking_status]}</h1>
    {booking.booking_status === 'cancelled' && cancelledAt && <p className="account-cancelled-on">{cancelledAt}</p>}
    {message && <p role="alert" className="account-note">{message}</p>}
    {mode === 'view' && <>
      {/* Linking Telegram is done as the signed-in client, so it is not offered on a page opened from the email link, where nobody has signed in. */}
      {open && !linked && <TelegramBox />}
      <BookingSummary booking={booking} />
      {owes && <p className="account-note account-note--fee">A late fee of {money(booking.late_fee_due_gbp)} is due for this appointment. I will be in touch about it.</p>}
      {booking.booking_status === 'cancelled' && Number(booking.refund_due_gbp) > 0 && <p className="account-note">A refund of {money(booking.refund_due_gbp)} is due to you. I'll send it soon.</p>}
      {open && terms?.can_change && <>
        <Terms terms={terms} action="reschedule" />
        <div className="actions"><button className="btn--primary" onClick={() => setMode('reschedule')}>Change the time</button><button className="btn--danger" onClick={() => setMode('cancel')}>Cancel appointment</button></div>
      </>}
      {open && terms && !terms.can_change && <p>This appointment can no longer be changed online. Please contact Vad.</p>}
    </>}
    {mode === 'cancel' && terms && <CancelPanel api={api} booking={booking} terms={terms} back={() => setMode('view')} refresh={load} done={result => done(result, 'Your appointment is cancelled.')} />}
    {mode === 'reschedule' && terms && <ReschedulePanel api={api} booking={booking} terms={terms} rules={rules} back={() => setMode('view')} refresh={load} done={result => done(result, 'Your appointment has been moved.')} />}
    <p><a href="https://vadmassage.com">Contact Vad</a></p>
    {signIn}
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
    <button className="tile account-booking" onClick={() => open(row.id)}>
      <span className="account-when">{dateLabel(row.date)} · {timeLabel(row.start_minutes)}</span>
      <span className="account-what">{servicesLabel(row.services)} · {row.treatment_duration_minutes} min</span>
      <span className={`chip chip--${CHIP[row.booking_status] || 'done'} account-status`}>{STATUS_TEXT[row.booking_status]}</span>
    </button>
  </li>
  return <>
    <h2 className="section-title">Coming up</h2>
    {upcoming.length ? <ul role="list" className="account-list">{upcoming.map(item)}</ul> : <p>You have no upcoming appointments. <a href="/">Book a treatment</a></p>}
    {earlier.length > 0 && <><h2 className="section-title">Earlier</h2><ul role="list" className="account-list">{earlier.map(item)}</ul></>}
  </>
}

export default function AccountApp() {
  const auth = useClientAuth(supabase)
  // An email link that was used already, or has run out, brings the person back here with the reason in the address.
  const linkProblem = useLinkProblem()
  const [start, setStart] = useState(readLink)
  const [selected, setSelected] = useState(start.booking)
  // A second link opened in this same tab changes only the part after the #, which does not reload the page: take the new code up.
  useEffect(() => {
    const changed = () => { if (new URLSearchParams(window.location.hash.replace(/^#/, '')).get('key')) setStart(readLink()) }
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])
  // Opened from the private link in an email: that one booking, on any device, with no sign-in (and whoever happens to be signed in here is ignored).
  const linked = Boolean(start.booking && start.key)
  const linkApi = useMemo(() => (linked ? createAccountApi(supabase, { bookingId: start.booking, key: start.key }) : null), [linked, start])
  useEffect(() => {
    if (!linked) return
    // The code leaves the address only once it is kept for this tab. Where storage is unavailable it stays, so a reload still opens the booking.
    let kept = false
    try { sessionStorage.setItem(keptCode(start.booking), start.key); kept = true } catch { /* Storage can be unavailable. */ }
    if (kept && window.location.hash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  }, [linked, start])
  const opened = useRef(false)
  useEffect(() => {
    const before = document.title
    document.title = `${selected ? 'Your appointment' : 'Your bookings'} · VadMassage`
    if (opened.current) setTimeout(() => document.querySelector('.booking-main h1')?.focus({ preventScroll: true }), 0)
    opened.current = true
    return () => { document.title = before }
  }, [selected])
  const [revision, setRevision] = useState(0)
  const rules = useBookingRules(supabase)
  function select(id) {
    setSelected(id)
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('booking', id); else url.searchParams.delete('booking')
    window.history.replaceState(null, '', url)
  }
  return <div className="booking-shell">
    <header className="brand"><a className="brand-link" href="/"><b className="brand-mark" aria-hidden="true">VM</b>VadMassage</a><a className="brand-aside" href="/">Book a treatment</a></header>
    <main className="booking-main">
    {linkProblem && <p role="alert" className="error">{linkProblem}</p>}
    {linked
      ? <Manage key={`${start.booking}:${start.key}`} id={start.booking} api={linkApi} linked rules={rules} close={() => {}} changed={() => setRevision(value => value + 1)} />
      : <>
        {!auth.ready && <p role="status">Checking your account…</p>}
        {auth.ready && !auth.session && <>
          {selected && <p className="notice">Booked as a guest? There is no password to enter. Use the link in your latest confirmation email, or the phone you booked on. If you have an account, sign in below.</p>}
          <AuthPanel client={supabase} heading="Sign in to see your bookings" redirectTo={`${window.location.origin}/account`} />
        </>}
        {auth.ready && auth.session && (selected
          ? <Manage key={selected} id={selected} api={accountApi} rules={rules} close={() => select(null)} changed={() => setRevision(value => value + 1)} />
          : <><h1 tabIndex={-1}>Your <em>bookings</em></h1><BookingList key={revision} open={select} /></>)}
      </>}
    </main>
    <footer>Personal treatments, thoughtfully arranged. <a href="https://vadmassage.com">Contact Vad</a></footer>
  </div>
}
