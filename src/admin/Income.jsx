import { useEffect, useState } from 'react'
import { money, today } from './calendarPresentation.js'
import { incomeApi } from './incomeApi.js'
import { barDescription, barLabel, calendarWeeks, comparisonText, csvFileName, dateLabelShort, dayDescription, dayShade, duration, hourSentence, incomeCsv, methodName, monthlyRates, nextAnchor, periodLabel, previousAnchor, rowNote, rowWhen, shortMoney, stillToComeText, workShare } from './incomePresentation.js'

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
  const [picked, setPicked] = useState({ key: '', date: '' })
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
  // A day tapped on the calendar narrows the list to that day; moving to another period forgets it.
  const day = picked.key === key ? picked.date : ''
  const shownRows = day ? state.rows.filter(row => row.date === day) : state.rows
  const owedDays = new Set((owed || []).map(row => row.date))
  function pick(date) { setPicked(current => ({ key, date: current.key === key && current.date === date ? '' : date })) }
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
  const bestDay = summary ? Math.max(...(summary.days || []).map(item => Number(item.received_gbp)), 0) : 0
  const hours = summary?.hours
  const rates = summary && (kind === 'year' || kind === 'tax_year') ? monthlyRates(summary.bars) : []
  const now = today()
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
        {kind === 'month' && summary.days ? <section className="admin-income-calendar" aria-labelledby="income-calendar-title">
          <h2 id="income-calendar-title" className="admin-income-subhead">Day by day</h2>
          <table className="admin-income-cal">
            <thead><tr>{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(name => <th key={name} scope="col" abbr={name}>{name[0]}</th>)}</tr></thead>
            <tbody>{calendarWeeks(summary.days).map(week => <tr key={week.find(Boolean).date}>{week.map((item, index) => <td key={item?.date || `empty-${index}`}>
              {item && <button type="button" aria-pressed={day === item.date} aria-label={dayDescription(item, owedDays.has(item.date))} onClick={() => pick(item.date)}
                className={`admin-income-day shade-${dayShade(item.received_gbp, bestDay)}${Number(item.to_come_gbp) > 0 ? ' is-booked' : ''}${item.date === now ? ' is-today' : ''}${owedDays.has(item.date) ? ' is-owed' : ''}`}>
                <span className="admin-income-day-number">{Number(item.date.slice(8))}</span>
                {Number(item.received_gbp) > 0 ? <span className="admin-income-day-money">{shortMoney(item.received_gbp)}</span>
                  : Number(item.to_come_gbp) > 0 ? <span className="admin-income-day-money">{shortMoney(item.to_come_gbp)}</span> : null}
              </button>}
            </td>)}</tr>)}</tbody>
          </table>
          <p className="admin-income-key" aria-hidden="true"><span className="key-received">Received</span><span className="key-booked">Booked, not paid yet</span><span className="key-owed">Money owed</span></p>
        </section> : <ol className={`admin-income-bars is-${kind}`} aria-label="Income in each part of the period">
          {(summary.bars || []).map(bar => <li key={bar.from} aria-label={barDescription(kind, bar)}>
            <span className="admin-income-bar" style={{ '--share': highest > 0 ? Number(bar.total_gbp) / highest : 0 }} aria-hidden="true" />
            <span className="admin-income-bar-label" aria-hidden="true">{barLabel(kind, bar)}</span>
          </li>)}
        </ol>}
        {hours && <section className="admin-income-hour" aria-labelledby="income-hour-title">
          <h2 id="income-hour-title" className="admin-income-subhead">Your hour</h2>
          {hours.per_hour_gbp === null ? <p className="admin-detail-hint">No paid appointments in this period yet, so there is no hourly figure.</p> : <>
            <p className="admin-income-rate"><span>Each working hour earned you</span><strong className="figure">{money(Number(hours.per_hour_gbp))}</strong><span>{hourSentence(hours)}</span></p>
            <div className="admin-income-split" role="img" aria-label={`Treatment ${duration(hours.work_minutes)}, travel ${duration(hours.travel_minutes)}`}>
              <span className="is-work" style={{ '--share': workShare(hours) }} /><span className="is-travel" />
            </div>
            <p className="admin-income-key" aria-hidden="true"><span className="key-work">Treatment {duration(hours.work_minutes)}</span><span className="key-travel">Travel {duration(hours.travel_minutes)}</span></p>
            {rates.length > 0 && <>
              <h3 className="admin-income-minor">Each month</h3>
              <ul role="list" className="admin-income-rates">{rates.map(rate => <li key={rate.from}><span>{rate.name}</span><span className="figure">{money(rate.per_hour_gbp)}</span></li>)}</ul>
            </>}
            {hours.areas?.length > 1 && <>
              <h3 className="admin-income-minor">By area</h3>
              <ul role="list" className="admin-income-rates">{hours.areas.map(area => <li key={area.name}><span>{area.name}</span><span className="figure">{money(Number(area.per_hour_gbp))}</span></li>)}</ul>
            </>}
            <p className="admin-detail-hint">Counts appointments that went ahead and were paid. Travel is the travel time set on each appointment: the journey there, and the journey home after the last one of the day.</p>
          </>}
        </section>}
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
          <h2 id="income-list-title">{day ? `Bookings on ${dateLabelShort(day)}` : 'Bookings'}</h2>
          <button type="button" className="btn--tonal btn--small" disabled={!state.rows.length} onClick={download}>Download for accountant</button>
        </div>
        {day && <button type="button" className="btn--tonal btn--small" onClick={() => pick(day)}>Show the whole month</button>}
        {shownRows.length ? <ul role="list" className="admin-income-list">
          {shownRows.map(row => <li key={row.booking_id}><button type="button" onClick={() => openBooking(row.booking_id)}>
            <span><strong>{row.client_name || 'Client'}</strong><small>{rowWhen(row)} · {rowNote(row)}</small></span><span className="figure">{money(Number(row.net_gbp))}</span>
          </button></li>)}
        </ul> : <p className="admin-detail-hint">{day ? 'No money received for appointments on this day.' : 'No money received for appointments in this period.'}</p>}
        <p className="admin-detail-hint">The file for your accountant lists these bookings: date, reference, client, {methodName('bank_transfer').toLowerCase()} or cash, amount received, refund and net.</p>
      </section>}
    </div>
  </section>
}
