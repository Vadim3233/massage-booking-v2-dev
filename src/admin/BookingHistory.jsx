import { useEffect, useState } from 'react'
import { activityApi } from './activityApi.js'
import { describeLine, stamp, storySummary } from './activityLine.js'
import { LineBody } from './ActivityParts.jsx'

// A booking's whole story at the bottom of its page (ADR-107), oldest first: what happened, when, and who did it (the client, you, or the app
// by itself), with old → new for every change. Every booking has it from its very first step.
export default function BookingHistory({ bookingId, version, api = activityApi }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    api.booking(bookingId).then(list => { if (live) { setRows(list || []); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, bookingId, version, attempt])
  return <section className="activity-history" aria-labelledby="history-title">
    <header className="activity-history-heading"><h3 id="history-title">History</h3>{rows?.length > 0 && <small>{storySummary(rows)}</small>}</header>
    {error && <p role="alert">{error} <button type="button" className="btn--small" onClick={() => setAttempt(value => value + 1)}>Retry</button></p>}
    {!rows && !error && <p role="status">Loading history…</p>}
    {rows && !rows.length && <p>Nothing recorded yet.</p>}
    {rows?.length > 0 && <ol className="activity-timeline">{rows.map(row => {
      const line = describeLine(row)
      return <li key={row.id}>
        <LineBody line={{ ...line, who: '', unread: false }} side={<small className="activity-stamp">{stamp(row.at)}</small>} />
        {(line.note || line.before) && <p className="activity-note">{line.before}{line.before && line.note ? ' · ' : ''}{line.note && <><strong>{row.event_type === 'client.note_added' ? 'Note: ' : 'Why: '}</strong>{line.note}</>}</p>}
      </li>
    })}</ol>}
  </section>
}
