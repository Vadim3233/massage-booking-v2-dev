import { useEffect, useState } from 'react'
import { googleCalendarApi, RETURN_MESSAGES } from './googleCalendarApi.js'

const when = stamp => stamp ? new Date(stamp).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'not yet'
const bookings = count => `${count} booking${Number(count) === 1 ? '' : 's'}`

// More › Google Calendar: connect the copy of the bookings in Google Calendar, see how it stands, resync or disconnect.
export default function SettingsGoogleCalendar({ api = googleCalendarApi, go = url => window.location.assign(url) }) {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState('')
  // Coming back from Google, the page's address says how it went: shown once, then taken out of the address.
  const [said, setSaid] = useState(() => {
    const result = new URLSearchParams(window.location.search).get('calendar')
    return result ? RETURN_MESSAGES[result] || RETURN_MESSAGES.error : null
  })
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('calendar')) window.history.replaceState(window.history.state, '', window.location.pathname)
  }, [])
  useEffect(() => {
    let live = true
    api.status().then(data => { if (live) { setStatus(data); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, attempt])
  async function act(work) {
    setBusy(true); setSaid(null)
    try { await work() } catch (failure) { setSaid(['alert', failure.message]) } finally { setBusy(false) }
  }
  const connect = () => act(async () => { go(await api.connectUrl()) })
  const resync = () => act(async () => { await api.resync(); setSaid(['status', 'Every booking will be copied again in the next few minutes.']); setAttempt(value => value + 1) })
  const disconnect = () => {
    if (!window.confirm('Disconnect Google Calendar? Bookings stop being copied. The VadMassage bookings calendar stays in Google; you can delete it there yourself.')) return
    act(async () => { await api.disconnect(); setSaid(['status', 'Disconnected. Bookings are no longer copied.']); setAttempt(value => value + 1) })
  }
  const message = said && <p role={said[0]} className={said[0] === 'alert' ? 'admin-field-error' : undefined}>{said[1]}</p>
  const heading = <header className="admin-review-heading"><div><h1 id="google-calendar-title">Google Calendar</h1></div></header>
  if (error && !status) return <section className="admin-review" aria-labelledby="google-calendar-title">{heading}<p role="alert">{error}</p><button onClick={() => setAttempt(value => value + 1)}>Try again</button></section>
  if (!status) return <section className="admin-review" aria-labelledby="google-calendar-title">{heading}<p role="status">Loading…</p></section>
  const state = status.status
  return <section className="admin-review admin-google-calendar" aria-labelledby="google-calendar-title">
    {heading}
    {message}
    {state === 'connected' && <>
      <p className="admin-calendar-state is-connected"><span aria-hidden="true">✓</span> Connected</p>
      <dl className="admin-calendar-facts">
        <dt>Account</dt><dd>{status.account_email || 'Your Google account'}</dd>
        <dt>Last copied</dt><dd>{when(status.last_success_at)}</dd>
        <dt>Waiting</dt><dd>{bookings(status.waiting)}</dd>
      </dl>
      {Number(status.failed) > 0 && <p className="admin-calendar-problem">{bookings(status.failed)} could not be copied{status.last_error ? `: ${status.last_error}` : ''}. Resync now tries again.</p>}
      {Number(status.failed) === 0 && status.last_error && status.last_error_at && (!status.last_success_at || status.last_error_at > status.last_success_at) && <p className="admin-calendar-problem">The last try did not work: {status.last_error} It is tried again by itself.</p>}
      <div className="admin-calendar-actions">
        <button type="button" className="btn--tonal" disabled={busy} onClick={resync}>Resync now</button>
        <button type="button" className="btn--quiet" disabled={busy} onClick={disconnect}>Disconnect</button>
      </div>
      <p className="admin-detail-hint">To show your wife when you are busy: in Google Calendar, open the settings of the VadMassage bookings calendar, choose Share with specific people, then See only free/busy (hide details).</p>
    </>}
    {state === 'needs_reconnect' && <>
      <p className="admin-calendar-state is-warning"><span aria-hidden="true">!</span> Needs reconnect</p>
      <p className="admin-calendar-problem">{status.last_error || 'Google asked you to connect again.'} Until you do, new bookings are not copied. Nothing is lost: everything is copied once you reconnect.</p>
      <button type="button" className="btn--primary btn--block" disabled={busy} onClick={connect}>{busy ? 'Opening Google…' : 'Connect again'}</button>
    </>}
    {state !== 'connected' && state !== 'needs_reconnect' && <>
      <p>Copies your bookings into a calendar of their own, “VadMassage bookings”, on your Google account. You can see them on your phone, even offline. Changes made in Google never change a booking.</p>
      <p className="admin-detail-hint">Events show the client’s name, the treatment and its length, the address (with directions, even offline), and your travel time after it. Never the phone, price or notes.</p>
      <button type="button" className="btn--primary btn--block" disabled={busy} onClick={connect}>{busy ? 'Opening Google…' : 'Connect Google Calendar'}</button>
    </>}
  </section>
}
