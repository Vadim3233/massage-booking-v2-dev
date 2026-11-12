import { useEffect, useMemo, useRef, useState } from 'react'
import { clientsApi, fullName } from './clientsApi.js'
import { initials } from './newBooking/presentation.js'
import { ClientForm } from './ClientForms.jsx'
import PossibleDuplicates from './PossibleDuplicates.jsx'
import { whatsappNumber } from './contactLinks.js'
import { TAGS, agoWords, clientLine, daysBetween, gapWords, goneQuiet, matches, mostLoyal, newNotBack, pounds, shortDate, tagCounts, tagLabel, tiles } from './clientStats.js'

// The tag next to a client's name: Regular, New, Quiet or Lapsed (ADR-099).
export function ClientTag({ tag }) {
  return tag ? <span className={`client-tag client-tag--${tag}`}>{tagLabel(tag)}</span> : null
}

function MessageLink({ row }) {
  const number = whatsappNumber(row.phone)
  return number ? <a className="client-stat-message" href={`https://wa.me/${number}`} target="_blank" rel="noopener noreferrer" aria-label={`Message ${fullName(row)} on WhatsApp`}>Message</a> : null
}

function WorthALook({ base, openClient, showQuiet }) {
  const [loyalBy, setLoyalBy] = useState('visits')
  const quiet = goneQuiet(base.clients)
  const fresh = newNotBack(base.clients, base.today).slice(0, 5)
  const loyal = mostLoyal(base.clients, loyalBy)
  if (!quiet.length && !fresh.length && !loyal.length) return null
  const person = (row, line) => <button className="client-stat-person" onClick={() => openClient(row.id)}>
    <span className="monogram" aria-hidden="true">{initials(row)}</span>
    <span className="admin-client-text"><strong>{fullName(row)}</strong><span>{line}</span></span>
  </button>
  return <section className="client-worth" aria-labelledby="worth-title">
    <h2 id="worth-title" className="client-worth-title">Worth a look</h2>
    {quiet.length > 0 && <section className="client-stat-card client-stat-card--quiet" aria-labelledby="quiet-title">
      <div className="client-stat-card-heading"><h3 id="quiet-title">Gone quiet</h3><span>{quiet.length} {quiet.length === 1 ? 'client' : 'clients'}</span></div>
      <p>Regulars well past their usual gap. A friendly message often brings them back.</p>
      <ul role="list">{quiet.slice(0, 3).map(row => <li key={row.id}>
        {person(row, `Usually ${gapWords(row.gap_days)} · last seen ${shortDate(row.last_visit)}`)}<MessageLink row={row} />
      </li>)}</ul>
      {quiet.length > 3 && <button className="btn--small" onClick={showQuiet}>See all {quiet.length}</button>}
    </section>}
    {fresh.length > 0 && <section className="client-stat-card" aria-labelledby="fresh-title">
      <div className="client-stat-card-heading"><h3 id="fresh-title">New, not back yet</h3><span>{fresh.length} {fresh.length === 1 ? 'client' : 'clients'}</span></div>
      <p>First visit in the last two months, nothing booked since.</p>
      <ul role="list">{fresh.map(row => <li key={row.id}>
        {person(row, `First visit ${shortDate(row.first_visit)} · ${agoWords(daysBetween(row.first_visit, base.today))}`)}<MessageLink row={row} />
      </li>)}</ul>
    </section>}
    {loyal.length > 0 && <section className="client-stat-card" aria-labelledby="loyal-title">
      <div className="client-stat-card-heading"><h3 id="loyal-title">Most loyal</h3>
        <div className="client-stat-toggle" role="group" aria-label="Sort by">
          {[['visits', 'Visits'], ['spent', 'Spent']].map(([key, label]) => <button key={key} aria-pressed={loyalBy === key} onClick={() => setLoyalBy(key)}>{label}</button>)}
        </div>
      </div>
      <ol role="list" className="client-loyal">{loyal.map((row, index) => <li key={row.id}>
        <span className="client-loyal-rank" aria-hidden="true">{index + 1}</span>
        {person(row, row.visits >= 3 && row.gap_days != null ? gapWords(row.gap_days) : `since ${shortDate(row.first_visit)}`)}
        <span className="client-loyal-figures"><strong>{row.visits} {row.visits === 1 ? 'visit' : 'visits'}</strong><span>{pounds(row.paid_gbp)}</span></span>
      </li>)}</ol>
    </section>}
  </section>
}

export default function Clients({ openClient, openCombine, api = clientsApi }) {
  const [query, setQuery] = useState('')
  const [term, setTerm] = useState('')
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [adding, setAdding] = useState(false)
  // The stats: null while loading, false when they could not be read (the page then works as before, without them).
  const [base, setBase] = useState(() => (api.base ? null : false))
  const [filter, setFilter] = useState('all')
  const searchRef = useRef(null)
  // Wait for a pause in typing so each keystroke is not a request.
  useEffect(() => { const timer = setTimeout(() => setTerm(query.trim()), 250); return () => clearTimeout(timer) }, [query])
  useEffect(() => {
    let live = true
    api.search(term).then(list => { if (live) { setRows(list); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, term, attempt])
  useEffect(() => {
    let live = true
    if (!api.base) return undefined
    api.base().then(value => { if (live) setBase(value) }, () => { if (live) setBase(false) })
    return () => { live = false }
  }, [api])
  const stats = useMemo(() => new Map((base?.clients ?? []).map(row => [row.id, row])), [base])
  const counts = useMemo(() => tagCounts(base?.clients ?? []), [base])
  async function create(details) {
    const created = await api.create(details, crypto.randomUUID())
    openClient(created.id)
  }
  function showQuiet() {
    setFilter('quiet')
    searchRef.current?.scrollIntoView({ block: 'start' })
  }
  const filtered = filter === 'all' ? null : (base?.clients ?? []).filter(row => row.tag === filter && matches(row, query))
  const list = filtered ?? rows
  return <section className="admin-review" aria-labelledby="clients-title">
    <header className="admin-review-heading"><div><h1 id="clients-title">Clients</h1><p>Find a client, or add someone new.</p></div></header>
    {adding ? <section aria-label="Add a client"><h2>Add a client</h2><ClientForm withAddress submitLabel="Add client" onSubmit={create} onCancel={() => setAdding(false)} /></section> : <>
      {base && <dl className="client-tiles" aria-label="Your clients at a glance">{tiles(base).map(tile => <div key={tile.key}>
        <dt>{tile.label}</dt><dd className="client-tile-value">{tile.value}</dd><dd>{tile.sub}</dd>
      </div>)}</dl>}
      {openCombine && <PossibleDuplicates openCombine={openCombine} api={api} />}
      <label className="admin-field" ref={searchRef}>Search by name, phone or email<input type="search" value={query} maxLength={100} onChange={event => setQuery(event.target.value)} /></label>
      {base && <div className="client-filters" role="group" aria-label="Show">
        <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All {base.total}</button>
        {TAGS.map(({ key, label }) => <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label} {counts[key]}</button>)}
      </div>}
      <div className="admin-payment-buttons"><button className="btn--tonal" onClick={() => setAdding(true)}>+ Add client</button></div>
      {error && !filtered && <p role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>Try again</button></p>}
      {!list && !error && <p role="status">Loading clients…</p>}
      {list && !list.length && <p>{filtered ? (query.trim() ? 'No one with this tag matches that search.' : `No ${tagLabel(filter).toLowerCase()} clients right now.`) : (term ? 'No one matches that search.' : 'No clients yet.')}</p>}
      {list?.length > 0 && <ul role="list" className="admin-client-list">{list.map(row => {
        const own = stats.get(row.id)
        return <li key={row.id}>
          <button onClick={() => openClient(row.id)}><span className="monogram" aria-hidden="true">{initials(row)}</span><span className="admin-client-text">
            <span className="client-name-row"><strong>{fullName(row)}</strong><ClientTag tag={own?.tag} /></span>
            <span>{row.phone || row.email || 'No contact details'}</span>
            {own && <span className="client-stat-line">{clientLine(own, base.today)}</span>}
          </span></button>
        </li>
      })}</ul>}
      {!filtered && rows?.length === 20 && <p className="admin-detail-hint">Showing the 20 best matches. Type more of the name, phone or email to narrow it down.</p>}
      {base && <WorthALook base={base} openClient={openClient} showQuiet={showQuiet} />}
    </>}
  </section>
}
