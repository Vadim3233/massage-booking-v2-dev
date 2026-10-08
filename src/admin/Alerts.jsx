import { useEffect, useState } from 'react'
import { alertsApi, bookingIdFromLink } from './alertsApi.js'

const when = value => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value))

export default function Alerts({ openBooking, openPage, changed, api = alertsApi }) {
  const [alerts, setAlerts] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    api.list().then(list => { if (live) { setAlerts(list); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, attempt])
  async function markAll() {
    try { await api.markRead(null); setAttempt(value => value + 1); changed() } catch (failure) { setError(failure.message) }
  }
  async function open(alert) {
    const id = bookingIdFromLink(alert.link_path)
    if (!alert.read_at) { try { await api.markRead([alert.id]); changed() } catch { /* Opening the booking still works. */ } }
    if (id) openBooking(id)
    else if (/^\/admin\/[a-z/-]+$/.test(alert.link_path || '')) openPage?.(alert.link_path)
  }
  const unread = (alerts || []).filter(alert => !alert.read_at).length
  return <section className="admin-review" aria-labelledby="alerts-title">
    <header className="admin-review-heading"><div><h1 id="alerts-title">Alerts</h1><p>What has happened since you last looked.</p></div>
      <button onClick={() => setAttempt(value => value + 1)} aria-label="Refresh alerts">↻</button></header>
    {error && <p role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>Retry alerts</button></p>}
    {!alerts && !error && <p role="status">Loading alerts…</p>}
    {alerts && !alerts.length && <p>Nothing yet. New bookings and client changes will appear here.</p>}
    {alerts?.length > 0 && <>
      <div className="admin-payment-buttons"><button disabled={!unread} onClick={markAll}>Mark all as read</button></div>
      <ul className="admin-alerts">{alerts.map(alert => <li key={alert.id} className={alert.read_at ? 'is-read' : 'is-unread'}>
        <button onClick={() => open(alert)}>
          <strong>{alert.title}</strong><span>{alert.body}</span><small>{when(alert.created_at)}{alert.read_at ? '' : ' · New'}</small>
        </button>
      </li>)}</ul>
    </>}
  </section>
}
