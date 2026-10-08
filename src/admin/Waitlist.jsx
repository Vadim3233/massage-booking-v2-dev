import { useEffect, useState } from 'react'
import { waitlistActions, waitlistApi, waitlistLabels, windowText } from './waitlistApi.js'
import { clientContactLinks } from './contactLinks.js'
import { dateLabel, time } from './calendarPresentation.js'

const stamp = value => new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

function Request({ request, busy, act, bookFor }) {
  const [note, setNote] = useState(request.admin_note || '')
  const links = clientContactLinks({ phone: request.contact_phone, email: request.contact_email })
  const matches = request.available_times || []
  return <li className={`admin-waitlist-item is-${request.status}`}>
    <div className="admin-setting-head">
      <strong>{request.contact_name}</strong>
      <span className="admin-detail-hint">{dateLabel(request.requested_date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} · {windowText(request.preferred_from_minutes, request.preferred_to_minutes)} · {request.duration_minutes} min</span>
    </div>
    {request.status === 'offered' && <p className="admin-detail-hint">You offered a time {request.offered_at ? stamp(request.offered_at) : ''}</p>}
    {request.status === 'closed' && <p className="admin-detail-hint">Closed: {request.close_reason === 'booked' ? 'booked' : request.close_reason === 'not_needed' ? 'no longer needed' : 'closed'}</p>}
    {request.note && <p>“{request.note}”</p>}
    {request.status !== 'closed' && (matches.length > 0
      ? <p className="admin-waitlist-match" role="status"><strong>Could be booked now:</strong> {matches.map(time).join(', ')}</p>
      : <p className="admin-detail-hint">Nothing free for them yet.</p>)}
    <nav className="admin-contact-actions" aria-label={`Contact ${request.contact_name}`}>{links.map(link => <a key={link.key} href={link.href} {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{link.label}</a>)}</nav>
    {request.status !== 'closed' && <>
      <label className="admin-field">Your note (only you see this)<input value={note} maxLength={500} disabled={busy} onChange={event => setNote(event.target.value)} /></label>
      <div className="admin-payment-buttons">
        {request.client_id && <button disabled={busy} onClick={() => bookFor(request)}>Book for them</button>}
        {waitlistActions(request).map(action => <button key={action} disabled={busy} onClick={() => act(request, action, note)}>{waitlistLabels[action]}</button>)}
      </div>
      {!request.client_id && <p className="admin-detail-hint">They have no client record yet. Add them under Clients, then book.</p>}
    </>}
  </li>
}

export default function Waitlist({ api = waitlistApi, bookFor }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [closed, setClosed] = useState(false)
  useEffect(() => {
    let live = true
    api.list(closed).then(list => { if (live) { setRows(list); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, attempt, closed])
  async function act(request, action, note) {
    setBusy(true); setError(''); setMessage('')
    try { await api.update(request.id, action, note); setMessage('Saved.'); setAttempt(value => value + 1) }
    catch (failure) { setError(failure.message); setAttempt(value => value + 1) }
    finally { setBusy(false) }
  }
  const open = (rows || []).filter(row => row.status !== 'closed')
  const shut = (rows || []).filter(row => row.status === 'closed')
  return <section className="admin-review" aria-labelledby="waitlist-title">
    <header className="admin-review-heading"><div><h1 id="waitlist-title">Waitlist</h1><p>People hoping for a day that was full. Nothing is booked for them until you do it.</p></div>
      <button onClick={() => setAttempt(value => value + 1)} aria-label="Refresh waitlist">↻</button></header>
    {error && <p role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>Try again</button></p>}
    {message && <p role="status">{message}</p>}
    {!rows && !error && <p role="status">Loading the waitlist…</p>}
    {rows && !open.length && <p>Nobody is waiting right now.</p>}
    {open.length > 0 && <ul className="admin-waitlist">{open.map(request => <Request key={request.id} request={request} busy={busy} act={act} bookFor={bookFor} />)}</ul>}
    <label className="admin-who-row"><input type="checkbox" checked={closed} onChange={event => setClosed(event.target.checked)} /> Show closed requests from the last 60 days</label>
    {closed && shut.length > 0 && <ul className="admin-waitlist">{shut.map(request => <Request key={request.id} request={request} busy={busy} act={act} bookFor={bookFor} />)}</ul>}
    {closed && rows && !shut.length && <p>No closed requests.</p>}
  </section>
}
