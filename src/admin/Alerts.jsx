import { useCallback, useEffect, useRef, useState } from 'react'
import { adminPageFromLink, alertsApi, bookingIdFromLink, groupAlerts, groupByDay } from './alertsApi.js'
import { useQuietRetry, useReturnRefresh } from './useReturnRefresh.js'

// The day is in the heading above the card, so a card only needs the time.
const clock = value => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }).format(new Date(value))

export default function Alerts({ openBooking, openPage, changed, api = alertsApi }) {
  const [alerts, setAlerts] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const hasList = useRef(false)
  const reread = useCallback(() => setAttempt(value => value + 1), [])
  const quiet = useQuietRetry(reread)
  useEffect(() => {
    let live = true
    api.list().then(list => {
      if (!live) return
      hasList.current = true
      quiet.succeeded()
      setAlerts(list)
      setError('')
    }, failure => {
      if (!live) return
      // A list already on screen that cannot be refreshed just now is tried once more, quietly, before anyone is told.
      if (hasList.current && quiet.failed()) return
      setError(failure.message)
    })
    return () => { live = false }
  }, [api, attempt, quiet])
  useReturnRefresh(reread)
  async function markAll() {
    try { await api.markRead(null); setAttempt(value => value + 1); changed() } catch (failure) { setError(failure.message) }
  }
  async function open(group) {
    const alert = group.head
    const id = bookingIdFromLink(alert.link_path)
    if (group.unreadIds.length) {
      try {
        await api.markRead(group.unreadIds)
        // The row stops saying "New" at once, rather than waiting for the list to be read again.
        const readAt = new Date().toISOString()
        setAlerts(list => list?.map(item => group.unreadIds.includes(item.id) ? { ...item, read_at: readAt } : item))
        changed()
      } catch { /* Opening the booking still works. */ }
    }
    const page = adminPageFromLink(alert.link_path)
    if (id) openBooking(id)
    else if (page) openPage?.(page)
  }
  const unread = (alerts || []).filter(alert => !alert.read_at).length
  return <section className="admin-review" aria-labelledby="alerts-title">
    <header className="admin-review-heading"><div><h1 id="alerts-title">Alerts</h1><p>What has happened since you last looked.</p></div>
      <button onClick={() => { quiet.asked(); reread() }} aria-label="Refresh alerts">↻</button></header>
    {error && <p role="alert">{error} <button onClick={() => { quiet.asked(); reread() }}>Retry alerts</button></p>}
    {!alerts && !error && <p role="status">Loading alerts…</p>}
    {alerts && !alerts.length && <p>Nothing yet. New bookings and client changes will appear here.</p>}
    {alerts?.length > 0 && <>
      <div className="admin-payment-buttons"><button className="btn--tonal btn--small" disabled={!unread} onClick={markAll}>Mark all as read</button></div>
      {groupByDay(groupAlerts(alerts)).map(day => <section key={day.date} className={`admin-alerts-day ${day.name === 'Today' ? 'is-today' : ''}`} aria-labelledby={`alerts-${day.date}`}>
        <header className="admin-agenda-day-heading">
          <h2 id={`alerts-${day.date}`}><span className="day-name">{day.name}</span>{day.rest ? ` · ${day.rest}` : ''}</h2>
          <span>{day.groups.length} {day.groups.length === 1 ? 'alert' : 'alerts'}{day.unread ? ` · ${day.unread} new` : ''}</span>
        </header>
        <ul role="list" className="admin-alerts">{day.groups.map(group => <li key={group.id} className={group.unreadIds.length ? 'is-unread' : 'is-read'}>
          <button onClick={() => open(group)}>
            <strong>{group.head.title}</strong><span>{group.head.body}</span>
            {group.older.length > 0 && <span className="admin-alert-also">Also: {group.older.map(alert => alert.title).join(' · ')}</span>}
            <small>{clock(group.head.created_at)}{group.unreadIds.length ? ' · New' : ''}</small>
          </button>
        </li>)}</ul>
      </section>)}
    </>}
  </section>
}
