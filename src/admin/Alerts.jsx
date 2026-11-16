import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { adminPageFromLink } from './alertsApi.js'
import { activityApi } from './activityApi.js'
import { clock, describeLine, linesByDay, mergeRepeats, stamp } from './activityLine.js'
import { openLabel } from './alertSummary.js'
import { LineBody, WhoChip } from './ActivityParts.jsx'
import { useQuietRetry, useReturnRefresh } from './useReturnRefresh.js'
import Icon from '../ui/icons.jsx'

// Alerts, now the record of what happened (ADR-107): everything that happened to bookings, clients and gift vouchers, newest first, with
// who did it. A client's action that raised an alert has the gold ring until it is read, as before; what Vadim did and what the app did by
// itself is there too, quieter. Tap a line to read it all, see what happened earlier to the same booking, and open it.
const FILTERS = [['all', 'Everything'], ['new', 'Needs you'], ['bookings', 'Bookings'], ['money', 'Money'], ['gifts', 'Gifts'], ['mine', 'By me']]
const PAGE = 50
const CHANNEL = { email: 'email', telegram: 'Telegram' }

function Sent({ sent }) {
  if (!sent?.length) return null
  const went = sent.filter(item => item.status === 'sent').map(item => CHANNEL[item.channel] || item.channel)
  const failed = sent.filter(item => item.status === 'failed').map(item => CHANNEL[item.channel] || item.channel)
  const waiting = sent.filter(item => ['pending', 'sending'].includes(item.status)).map(item => CHANNEL[item.channel] || item.channel)
  return <p className="activity-sent">
    {went.length > 0 && <>Sent to the client by {went.join(' and ')}. </>}
    {waiting.length > 0 && <>Still sending by {waiting.join(' and ')}. </>}
    {failed.length > 0 && <span className="activity-tag is-late">Not sent by {failed.join(' and ')}</span>}
  </p>
}

// What happened earlier to the same booking: the three lines before this one, and a way to the whole story.
function Earlier({ bookingId, before, api, openBooking }) {
  const [rows, setRows] = useState(null)
  useEffect(() => {
    let live = true
    api.booking(bookingId).then(list => { if (live) setRows(list || []) }, () => { if (live) setRows(false) })
    return () => { live = false }
  }, [api, bookingId])
  if (!rows) return null
  const earlier = rows.filter(row => row.at < before).slice(-3).reverse()
  if (!earlier.length) return null
  return <div className="activity-earlier">
    <h3>Earlier on this booking</h3>
    <ul role="list">{earlier.map(row => {
      const line = describeLine(row)
      return <li key={row.id} className="activity-earlier-line"><LineBody line={{ ...line, who: '', unread: false }} side={<small className="activity-stamp">{stamp(row.at)}</small>} /></li>
    })}</ul>
    {rows.length > earlier.length + 1 && <button type="button" className="btn--quiet btn--small" onClick={openBooking}>See all {rows.length} on the booking</button>}
  </div>
}

export default function Alerts({ openBooking, openPage, changed, unread: unreadCount = 0, api = activityApi }) {
  const [filter, setFilter] = useState('all')
  const [typed, setTyped] = useState('')
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState(null)
  const [full, setFull] = useState(true)
  const [more, setMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const hasList = useRef(false)
  const reread = useCallback(() => setAttempt(value => value + 1), [])
  const quiet = useQuietRetry(reread)

  // The name search waits until typing stops.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(typed.trim()), 300)
    return () => clearTimeout(timer)
  }, [typed])

  useEffect(() => {
    let live = true
    api.list({ filter, search, limit: PAGE }).then(result => {
      if (!live) return
      hasList.current = true
      quiet.succeeded()
      setRows(result.rows)
      setFull(result.full)
      setMore(result.full && result.rows.length >= PAGE)
      setError('')
    }, failure => {
      if (!live) return
      // A list already on screen that cannot be refreshed just now is tried once more, quietly, before anyone is told.
      if (hasList.current && quiet.failed()) return
      setError(failure.message)
    })
    return () => { live = false }
  }, [api, attempt, quiet, filter, search])
  useReturnRefresh(reread)

  async function older() {
    const last = rows?.at(-1)
    if (!last || loadingMore) return
    setLoadingMore(true)
    try {
      const result = await api.list({ filter, search, before: { at: last.at, id: last.id }, limit: PAGE })
      setRows(list => [...list, ...result.rows.filter(row => !list.some(item => item.id === row.id))])
      setMore(result.rows.length >= PAGE)
    } catch (failure) { setError(failure.message) } finally { setLoadingMore(false) }
  }

  async function markAll() {
    try { await api.markRead(null); reread(); changed() } catch (failure) { setError(failure.message) }
  }
  const [opened, setOpened] = useState(() => new Set())
  async function markRead(item) {
    if (!item.unreadIds.length) return
    try {
      await api.markRead(item.unreadIds)
      // The line stops being new at once, rather than waiting for the list to be read again.
      const readAt = new Date().toISOString()
      setRows(list => list?.map(row => item.unreadIds.includes(row.alert_id) ? { ...row, alert_read_at: readAt } : row))
      changed()
    } catch { /* Opening it still works. */ }
  }
  async function toggle(item) {
    const wasOpen = opened.has(item.id)
    setOpened(ids => { const next = new Set(ids); if (wasOpen) next.delete(item.id); else next.add(item.id); return next })
    if (!wasOpen) await markRead(item)
  }
  async function open(item) {
    await markRead(item)
    const page = adminPageFromLink(item.line.link)
    if (item.line.bookingId) openBooking(item.line.bookingId)
    else if (page) openPage?.(page)
  }

  const items = useMemo(() => mergeRepeats(rows || []), [rows])
  const anyUnread = unreadCount > 0 || items.some(item => item.unreadIds.length)
  return <section className="admin-review" aria-labelledby="alerts-title">
    <header className="admin-review-heading"><div><h1 id="alerts-title">Alerts</h1><p>Everything that happened, when, and who did it.</p></div>
      <button onClick={() => { quiet.asked(); reread() }} aria-label="Refresh alerts"><Icon name="refresh" size={20} /></button></header>
    <div className="activity-filters" role="group" aria-label="Show">
      {FILTERS.map(([key, text]) => <button key={key} type="button" className="activity-filter" aria-pressed={filter === key} onClick={() => { setFilter(key); setOpened(new Set()) }}>
        {text}{key === 'new' && unreadCount > 0 && <em> {unreadCount > 99 ? '99+' : unreadCount}</em>}</button>)}
    </div>
    <div className="activity-tools">
      <label className="activity-search"><span className="admin-sr-only">Search by name</span>
        <input type="search" placeholder="Search by name" value={typed} onChange={event => setTyped(event.target.value)} /></label>
      <button className="btn--tonal btn--small" disabled={!anyUnread} onClick={markAll}>Mark all as read</button>
    </div>
    {!full && <p className="admin-detail-hint">Showing alerts only. The full record (what you and the app did) appears once the database update is applied.</p>}
    {error && <p role="alert">{error} <button onClick={() => { quiet.asked(); reread() }}>Retry alerts</button></p>}
    {!rows && !error && <p role="status">Loading alerts…</p>}
    {rows && !rows.length && <p>{search ? `Nothing for "${search}".` : filter === 'new' ? 'Nothing new. You are up to date.' : 'Nothing yet. New bookings and changes will appear here.'}</p>}
    {items.length > 0 && linesByDay(items).map(day => <section key={day.date} className={`admin-alerts-day ${day.name === 'Today' ? 'is-today' : ''}`} aria-labelledby={`alerts-${day.date}`}>
      <header className="admin-agenda-day-heading">
        <h2 id={`alerts-${day.date}`}><span className="day-name">{day.name}</span>{day.rest ? ` · ${day.rest}` : ''}</h2>
        <span>{day.items.length} {day.items.length === 1 ? 'thing' : 'things'}{day.unread ? ` · ${day.unread} new` : ''}</span>
      </header>
      <ul role="list" className="admin-alerts">{day.items.map(item => {
        const { line, head } = item
        const isOpen = opened.has(item.id)
        const target = line.bookingId || adminPageFromLink(line.link)
        const detailsId = `alert-${item.id}`
        const tone = item.unreadIds.length ? 'is-unread' : line.alert ? 'is-read' : 'is-quiet'
        return <li key={item.id} className={`${tone} ${isOpen ? 'is-open' : ''}`}>
          <button type="button" className="admin-alert-row" aria-expanded={isOpen} aria-controls={isOpen ? detailsId : undefined} onClick={() => toggle(item)}>
            <LineBody line={{ ...line, unread: item.unreadIds.length > 0 }} side={<span className="admin-alert-side">{line.amount && <b>{line.amount}</b>}<small>{clock(head.at)}</small></span>} />
          </button>
          {isOpen && <div id={detailsId} className="admin-alert-details">
            {head.alert_body && <p>{head.alert_title && head.alert_title !== line.what && <strong>{head.alert_title}. </strong>}{head.alert_body}</p>}
            {!head.alert_body && <p><WhoChip line={line} /> {stamp(head.at)}{line.times > 1 ? ` · the last of ${line.times} changes in a few minutes` : ''}</p>}
            {line.before && <p>{line.before}</p>}
            {line.note && <p className="activity-note"><strong>{head.event_type === 'client.note_added' ? 'Note: ' : 'Why: '}</strong>{line.note}</p>}
            <Sent sent={head.sent} />
            {line.bookingId && full && <Earlier bookingId={line.bookingId} before={item.rows.at(-1).at} api={api} openBooking={() => open(item)} />}
            {target && <button type="button" className="btn--small" onClick={() => open(item)}>{line.bookingId ? 'Open booking' : openLabel(line.link)}</button>}
          </div>}
        </li>
      })}</ul>
    </section>)}
    {more && <div className="admin-payment-buttons"><button type="button" className="btn--quiet" disabled={loadingMore} onClick={older}>{loadingMore ? 'Loading…' : 'Show older'}</button></div>}
  </section>
}
