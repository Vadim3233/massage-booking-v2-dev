import { useEffect, useState } from 'react'
import { visitorsApi } from './visitorsApi.js'
import { clientContactLinks } from './contactLinks.js'
import { dateLabel, today } from './calendarPresentation.js'
import Icon from '../ui/icons.jsx'
import {
  BANDS, OUTCOMES, PERIODS, WEEKDAYS, biggestDrop, busiestWanted, changeText, followUps, lastBookedText, outcomeOf, periodRange, preferences, shade,
  stageOf, STAGES, stepLines, summarize, visitClock, visitDay, visitorName, visitsIn, wantedGrid, whatText,
} from './visitorsPresentation.js'

const REMEMBER = 'vad-admin-visitors-period'
function remembered() {
  try { const saved = localStorage.getItem(REMEMBER); if (PERIODS.some(([key]) => key === saved)) return saved } catch { /* A default is fine. */ }
  return 'week'
}
const FILTERS = [['all', 'All'], ['booked', OUTCOMES.booked], ['no_time', OUTCOMES.no_time], ['asked', OUTCOMES.asked], ['payment', OUTCOMES.payment], ['looked', OUTCOMES.looked]]

function Visit({ visit, open, toggle }) {
  const outcome = outcomeOf(visit)
  const stage = stageOf(visit)
  return <li className={`admin-visit is-${outcome}`}>
    <button type="button" aria-expanded={open} onClick={toggle}>
      <span className="admin-visit-time figure">{visitClock(visit)}</span>
      <span className="admin-visit-main">
        <strong className={visit.client_id ? '' : 'is-anon'}>{visitorName(visit)}</strong>
        <span className="admin-visit-steps" aria-label={`Got to: ${STAGES[stage].toLowerCase()}`}>{STAGES.slice(1).map((label, index) => <i key={label} className={index < stage ? 'is-on' : ''} />)}</span>
        <small>{whatText(visit)}</small>
      </span>
      <span className={`admin-visit-pill is-${outcome}`}>{OUTCOMES[outcome]}</span>
    </button>
    {open && <ol className="admin-visit-detail">{stepLines(visit).map((line, index) => <li key={index}><span className="figure">{line.at}</span>{line.text}</li>)}</ol>}
  </li>
}

// More › Visitors (ADR-095): who opened the booking page, how far they got and how it ended, the times people wanted but could not get, and
// the clients worth a message.
export default function Visitors({ api = visitorsApi, openClient, openRules }) {
  const [period, setPeriod] = useState(remembered)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState({ key: '', visits: [], error: '' })
  const [filter, setFilter] = useState('all')
  const [opened, setOpened] = useState(() => new Set())
  const now = today()
  const range = periodRange(period, now)
  const key = `${period}:${now}:${attempt}`
  useEffect(() => { try { localStorage.setItem(REMEMBER, period) } catch { /* Only a convenience. */ } }, [period])
  useEffect(() => {
    let live = true
    api.visits(range.previousFrom, range.to)
      .then(visits => { if (live) setState({ key, visits, error: '' }) }, failure => { if (live) setState({ key, visits: [], error: failure.message }) })
    return () => { live = false }
  }, [api, key, range.previousFrom, range.to])
  const loading = state.key !== key
  const current = visitsIn(state.visits, range.from, range.to)
  const before = summarize(visitsIn(state.visits, range.previousFrom, range.previousTo))
  const sum = summarize(current)
  const drop = biggestDrop(sum.funnel)
  const cells = wantedGrid(current)
  const most = Math.max(0, ...cells.flat())
  const busiest = busiestWanted(cells)
  const prefs = preferences(current)
  const people = followUps(current)
  const counts = Object.fromEntries(FILTERS.map(([id]) => [id, id === 'all' ? current.length : current.filter(visit => outcomeOf(visit) === id).length]))
  const shown = filter === 'all' ? current : current.filter(visit => outcomeOf(visit) === filter)
  const byDay = []
  for (const visit of shown) {
    const day = visitDay(visit)
    if (byDay.at(-1)?.day !== day) byDay.push({ day, visits: [] })
    byDay.at(-1).visits.push(visit)
  }
  const toggle = id => setOpened(known => { const next = new Set(known); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const compared = period === 'today' ? 'yesterday' : `the ${range.days} days before`

  return <section className="admin-review admin-visitors" aria-labelledby="visitors-title">
    <header className="admin-review-heading"><div><h1 id="visitors-title">Visitors</h1><p>Who opened your booking page, how far they got, and the times they wanted.</p></div>
      <button onClick={() => setAttempt(value => value + 1)} aria-label="Refresh visitors"><Icon name="refresh" size={20} /></button></header>
    <div className="admin-tabs admin-visitors-tabs" role="group" aria-label="Period">
      {PERIODS.map(([id, text]) => <button key={id} type="button" aria-pressed={period === id} onClick={() => { setPeriod(id); setFilter('all') }}>{text}</button>)}
    </div>
    {state.error && !loading && <><p role="alert">{state.error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button></>}
    {loading && <p role="status">Loading visitors…</p>}
    {!loading && !state.error && <>
      <section className="admin-visitors-card" aria-labelledby="visitors-summary-title">
        <h2 id="visitors-summary-title" className="admin-income-subhead">{period === 'today' ? 'Today' : `Last ${range.days} days`}</h2>
        <p className="admin-detail-hint">Compared with {compared}</p>
        <dl className="admin-visitors-stats">
          <div><dt>opened the app</dt><dd className="figure">{sum.opened}</dd><span>{changeText(sum.opened, before.opened)}</span></div>
          <div><dt>booked</dt><dd className="figure">{sum.booked}</dd><span>{changeText(sum.booked, before.booked)}</span></div>
          <div><dt>left, no time free</dt><dd className="figure">{sum.noTime}</dd><span>{changeText(sum.noTime, before.noTime)}</span></div>
        </dl>
        {sum.opened > 0 && <ol className="admin-visitors-funnel" aria-label="How far people got">
          {sum.funnel.map((step, index) => <li key={step.label}>
            <span>{step.label}</span>
            <span className="admin-visitors-track" aria-hidden="true"><span className={index === sum.funnel.length - 1 ? 'is-booked' : ''} style={{ '--share': step.count / sum.opened }} /></span>
            <b className="figure">{step.count}</b>
          </li>)}
        </ol>}
        {drop && <p className="admin-visitors-drop"><b>Biggest drop:</b> {drop}</p>}
        {sum.opened === 0 && <p>Nobody has opened the booking page in this period yet.</p>}
      </section>

      <section className="admin-visitors-card" aria-labelledby="visitors-wanted-title">
        <h2 id="visitors-wanted-title" className="admin-income-subhead">Times people wanted but couldn't get</h2>
        <p className="admin-detail-hint">Each faded time a client tapped on the booking page. Darker means wanted more often.</p>
        <div className="admin-visitors-heat-wrap">
          <table className="admin-visitors-heat">
            <thead><tr><td />{WEEKDAYS.map(day => <th key={day} scope="col">{day}</th>)}</tr></thead>
            <tbody>{BANDS.map(([, , name], band) => <tr key={name}><th scope="row">{name}</th>
              {cells[band].map((count, day) => <td key={day} aria-label={`${WEEKDAYS[day]} ${name}: wanted ${count} ${count === 1 ? 'time' : 'times'}`}><span className={`heat-${shade(count, most)}`} /></td>)}</tr>)}</tbody>
          </table>
        </div>
        {busiest ? <p className="admin-visitors-tip">{busiest.text}</p> : <p className="admin-detail-hint">No faded times tapped in this period.</p>}
        {prefs.length > 0 && <>
          <h3 className="admin-income-minor">“None of these suit me”</h3>
          <ul role="list" className="admin-visitors-prefs">{prefs.map(item => <li key={item.key}><span>{item.label}</span><b className="figure">{item.count}</b></li>)}</ul>
        </>}
        {openRules && <p className="admin-detail-hint">Clients can ask about times within your hours and a little after them. <button type="button" className="btn--quiet btn--small" onClick={openRules}>Change the evening hours</button></p>}
      </section>

      <section className="admin-visitors-card" aria-labelledby="visitors-follow-title">
        <h2 id="visitors-follow-title" className="admin-income-subhead">Worth a message</h2>
        <p className="admin-detail-hint">Clients you know who looked at times but didn't book.</p>
        {people.length ? <ul role="list" className="admin-visitors-people">{people.map(visit => <li key={visit.visit_id}>
          <div className="admin-visitors-person">
            <strong>{visitorName(visit)}</strong><span className="admin-detail-hint">{lastBookedText(visit.last_booked, now)}</span>
          </div>
          <p>{dateLabel(visitDay(visit), { weekday: 'short', day: 'numeric', month: 'short' })} {visitClock(visit)} · {whatText(visit)}</p>
          <nav className="admin-contact-actions" aria-label={`Contact ${visitorName(visit)}`}>
            {clientContactLinks({ phone: visit.client_phone, email: visit.client_email }).map(link => <a key={link.key} href={link.href} {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}><Icon name={link.icon} />{link.label}</a>)}
            {openClient && <button type="button" className="btn--tonal btn--small" onClick={() => openClient(visit.client_id)}>Open client</button>}
          </nav>
        </li>)}</ul> : <p className="admin-detail-hint">Nobody to follow up in this period.</p>}
      </section>

      <section className="admin-visitors-card" aria-labelledby="visitors-list-title">
        <h2 id="visitors-list-title" className="admin-income-subhead">Every visit</h2>
        <div className="admin-visitors-filters" role="group" aria-label="Show">
          {FILTERS.map(([id, text]) => <button key={id} type="button" className="chip-button" aria-pressed={filter === id} onClick={() => setFilter(id)}>{text} {counts[id]}</button>)}
        </div>
        {byDay.map(group => <div key={group.day}>
          <h3 className="admin-visitors-day">{dateLabel(group.day, { weekday: 'long', day: 'numeric', month: 'short' })}</h3>
          <ul role="list" className="admin-visits">{group.visits.map(visit => <Visit key={visit.visit_id} visit={visit} open={opened.has(visit.visit_id)} toggle={() => toggle(visit.visit_id)} />)}</ul>
        </div>)}
        {!shown.length && <p className="admin-detail-hint">No visits to show.</p>}
      </section>
      <p className="admin-detail-hint">Visits are kept for 90 days, then deleted. No cookies and no IP addresses; visitors who are not signed in are not named.</p>
    </>}
  </section>
}
