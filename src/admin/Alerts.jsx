import { useEffect, useState } from 'react'
import { alertsApi, bookingIdFromLink, groupAlerts } from './alertsApi.js'

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
  async function open(group) {
    const alert = group.head
    const id = bookingIdFromLink(alert.link_path)
    if (group.unreadIds.length) { try { await api.markRead(group.unreadIds); changed() } catch { /* Opening the booking still works. */ } }
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
      <div className="admin-payment-buttons"><button className="btn--tonal btn--small" disabled={!unread} onClick={markAll}>Mark all as read</button></div>
      <ul className="admin-alerts">{groupAlerts(alerts).map(group => <li key={group.id} className={group.unreadIds.length ? 'is-unread' : 'is-read'}>
        <button onClick={() => open(group)}>
          <strong>{group.head.title}</strong><span>{group.head.body}</span>
          {group.older.length > 0 && <span className="admin-alert-also">Also: {group.older.map(alert => alert.title).join(' · ')}</span>}
          <small>{when(group.head.created_at)}{group.unreadIds.length ? ' · New' : ''}</small>
        </button>
      </li>)}</ul>
    </>}
  </section>
}
