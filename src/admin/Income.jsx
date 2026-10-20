import { useEffect, useState } from 'react'
import { money, today } from './calendarPresentation.js'
import { incomeApi } from './incomeApi.js'
import { barDescription, barLabel, comparisonText, csvFileName, incomeCsv, methodName, nextAnchor, periodLabel, previousAnchor, rowNote, rowWhen, stillToComeText } from './incomePresentation.js'

const TABS = [['week', 'Week'], ['month', 'Month'], ['year', 'Year']]
const REMEMBER = 'vad-admin-income-view'
function remembered() {
  try { const saved = JSON.parse(localStorage.getItem(REMEMBER)); if (['week', 'month', 'year'].includes(saved?.tab)) return saved } catch { /* A default is fine. */ }
  return { tab: 'month', tax: false }
}

// More › Income: money actually received, by the date of the appointment (Vadim's change requests 3 and 4). The database works out every figure
// (admin_income_summary, admin_income_rows, admin_money_owed); this page shows them, moves between periods and saves the accountant's file.
export default function Income({ openBooking, api = incomeApi }) {
  const [view, setView] = useState(remembered)
  const [anchor, setAnchor] = useState(today)
  const [state, setState] = useState({ key: '', summary: null, rows: [], error: '' })
  const [owed, setOwed] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const kind = view.tab === 'year' && view.tax ? 'tax_year' : view.tab
  const key = `${kind}:${anchor}:${attempt}`
  useEffect(() => { try { localStorage.setItem(REMEMBER, JSON.stringify(view)) } catch { /* Only a convenience. */ } }, [view])
  useEffect(() => {
    let live = true
    api.summary(kind, anchor)
      .then(summary => api.rows(summary.from, summary.to).then(rows => ({ summary, rows })))
      .then(({ summary, rows }) => { if (live) setState({ key, summary, rows: rows || [], error: '' }) }, failure => { if (live) setState({ key, summary: null, rows: [], error: failure.message }) })
    return () => { live = false }
  }, [api, kind, anchor, key])
  useEffect(() => {
    let live = true
    api.owed().then(rows => { if (live) setOwed(rows || []) }, () => { if (live) setOwed([]) })
    return () => { live = false }
  }, [api, attempt])
  const loading = state.key !== key
  const summary = loading ? null : state.summary
  function choose(tab) { setView(current => ({ ...current, tab })); setAnchor(today()) }
  function move(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = TABS.findIndex(([id]) => id === view.tab)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length
    choose(TABS[next][0])
    requestAnimationFrame(() => document.getElementById(`income-tab-${TABS[next][0]}`)?.focus())
  }
  function download() {
    const blob = new Blob([incomeCsv(state.rows)], { type: 'text/csv;charset=utf-8' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = csvFileName(summary)
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }
  const highest = summary ? Math.max(...(summary.bars || []).map(bar => Number(bar.total_gbp)), 0) : 0
  const still = summary ? stillToComeText(summary) : ''
  return <section className="admin-review admin-income" aria-labelledby="income-title">
    <header className="admin-review-heading"><div><h1 id="income-title">Income</h1><p>Money received, by the date of the appointment.</p></div></header>
    <div className="admin-tabs admin-income-tabs" role="tablist" aria-label="Income periods" onKeyDown={move}>
      {TABS.map(([id, text]) => <button key={id} id={`income-tab-${id}`} role="tab" aria-selected={view.tab === id} aria-controls="income-panel" tabIndex={view.tab === id ? 0 : -1} onClick={() => choose(id)}>{text}</button>)}
    </div>
    <div id="income-panel" role="tabpanel" aria-labelledby={`income-tab-${view.tab}`}>
      {view.tab === 'year' && <div className="admin-income-yeartype" role="group" aria-label="Kind of year">
        {[[false, 'Calendar year'], [true, 'Tax year']].map(([tax, text]) => <button key={text} type="button" className="chip-button" aria-pressed={view.tax === tax} onClick={() => { setView(current => ({ ...current, tax })); setAnchor(today()) }}>{text}</button>)}
      </div>}
      <nav className="admin-income-period" aria-label="Choose the period">
        <button type="button" className="admin-income-arrow" aria-label="Previous period" disabled={!summary} onClick={() => setAnchor(previousAnchor(summary))}>‹</button>
        <h2 aria-live="polite">{summary ? periodLabel(summary) : '…'}{summary?.upcoming && <span className="admin-income-upcoming">Upcoming</span>}</h2>
        <button type="button" className="admin-income-arrow" aria-label="Next period" disabled={!summary} onClick={() => setAnchor(nextAnchor(summary))}>›</button>
      </nav>
      {state.error && !loading && <><p role="alert">{state.error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button></>}
      {loading && <p role="status">Loading income…</p>}
      {summary && <>
        <div className="admin-income-total">
          <strong className="figure">{money(Number(summary.total_gbp))}</strong>
          <span className="admin-income-compare">{comparisonText(summary)}</span>
        </div>
        {still && <p className="admin-income-still">{still}</p>}
        <dl className="admin-income-facts">
          <div><dt>Bank transfer</dt><dd>{money(Number(summary.bank_gbp))}</dd></div>
          <div><dt>Cash</dt><dd>{money(Number(summary.cash_gbp))}</dd></div>
          <div><dt>Bookings</dt><dd>{summary.bookings}</dd></div>
          <div><dt>Average per booking</dt><dd>{summary.average_gbp === null ? '—' : money(Number(summary.average_gbp))}</dd></div>
        </dl>
        <ol className={`admin-income-bars is-${kind}`} aria-label="Income in each part of the period">
          {(summary.bars || []).map(bar => <li key={bar.from} aria-label={barDescription(kind, bar)}>
            <span className="admin-income-bar" style={{ '--share': highest > 0 ? Number(bar.total_gbp) / highest : 0 }} aria-hidden="true" />
            <span className="admin-income-bar-label" aria-hidden="true">{barLabel(kind, bar)}</span>
          </li>)}
        </ol>
      </>}
      {owed && owed.length > 0 && <details className="admin-income-owed">
        <summary><span>Money owed to you</span><span className="admin-income-count" aria-label={`${owed.length} appointments`}>{owed.length}</span></summary>
        <p className="admin-detail-hint">Appointments that have happened with money still missing. Open one to mark it paid or received.</p>
        <ul role="list" className="admin-income-list">
          {owed.map(row => <li key={`${row.booking_id}:${row.reason}`}><button type="button" onClick={() => openBooking(row.booking_id)}>
            <span><strong>{row.client_name || 'Client'}</strong><small>{rowWhen(row)} · {row.reason}</small></span><span className="figure">{money(Number(row.amount_gbp))}</span>
          </button></li>)}
        </ul>
      </details>}
      {summary && <section aria-labelledby="income-list-title" className="admin-income-section">
        <div className="admin-income-list-head">
          <h2 id="income-list-title">Bookings</h2>
          <button type="button" className="btn--tonal btn--small" disabled={!state.rows.length} onClick={download}>Download for accountant</button>
        </div>
        {state.rows.length ? <ul role="list" className="admin-income-list">
          {state.rows.map(row => <li key={row.booking_id}><button type="button" onClick={() => openBooking(row.booking_id)}>
            <span><strong>{row.client_name || 'Client'}</strong><small>{rowWhen(row)} · {rowNote(row)}</small></span><span className="figure">{money(Number(row.net_gbp))}</span>
          </button></li>)}
        </ul> : <p className="admin-detail-hint">No money received for appointments in this period.</p>}
        <p className="admin-detail-hint">The file for your accountant lists these bookings: date, reference, client, {methodName('bank_transfer').toLowerCase()} or cash, amount received, refund and net.</p>
      </section>}
    </div>
  </section>
}
