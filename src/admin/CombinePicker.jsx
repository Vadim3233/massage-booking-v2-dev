import { useEffect, useState } from 'react'
import { clientsApi, fullName } from './clientsApi.js'
import { matchedText } from './samePerson.js'

const RECENT = 5

// On a client's page: choose the other profile to compare this one with. The app's own guesses come first.
export default function CombinePicker({ clientId, openCombine, close, api = clientsApi }) {
  const [query, setQuery] = useState('')
  const [term, setTerm] = useState('')
  const [rows, setRows] = useState(null)
  const [suggested, setSuggested] = useState([])
  const [error, setError] = useState('')
  useEffect(() => { const timer = setTimeout(() => setTerm(query.trim()), 250); return () => clearTimeout(timer) }, [query])
  useEffect(() => {
    let live = true
    api.search(term).then(list => { if (live) { setRows(list.filter(row => row.id !== clientId)); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, term, clientId])
  useEffect(() => {
    let live = true
    api.possibleDuplicates().then(list => { if (live) setSuggested((list || []).filter(pair => pair.client_a === clientId || pair.client_b === clientId)) }, () => { /* Only a help. */ })
    return () => { live = false }
  }, [api, clientId])
  return <section aria-label="Combine with another client" className="admin-combine-picker">
    {suggested.length > 0 && <>
      <p className="admin-detail-hint">The app thinks this might be the same person:</p>
      <ul role="list" className="admin-client-list">{suggested.map(pair => {
        const otherId = pair.client_a === clientId ? pair.client_b : pair.client_a
        return <li key={otherId}><button onClick={() => openCombine(clientId, otherId)}>
          <span className="admin-client-text"><strong>{pair.client_a === clientId ? pair.b_name : pair.a_name}</strong><span>Same {matchedText(pair.matched_on)}</span></span>
        </button></li>
      })}</ul></>}
    <label className="admin-field">Find the other client by name, phone or email<input type="search" value={query} maxLength={100} onChange={event => setQuery(event.target.value)} /></label>
    {error && <p role="alert" className="admin-field-error">{error}</p>}
    {rows && !rows.length && <p>{term ? 'No one matches that search.' : 'No other clients yet.'}</p>}
    {rows?.length > 0 && <ul role="list" className="admin-client-list">{(term ? rows : rows.slice(0, RECENT)).map(row => <li key={row.id}><button onClick={() => openCombine(clientId, row.id)}>
      <span className="admin-client-text"><strong>{fullName(row)}</strong><span>{row.phone || row.email || 'No contact details'}</span></span>
    </button></li>)}</ul>}
    {!term && rows?.length > RECENT && <p className="admin-detail-hint">Showing the {RECENT} most recent. Type a name, phone or email to find anyone else.</p>}
    <div className="admin-payment-buttons"><button className="btn--quiet" onClick={close}>Cancel</button></div>
  </section>
}
