import { useEffect, useState } from 'react'
import { clientsApi, fullName } from './clientsApi.js'
import { ClientForm } from './ClientForms.jsx'

export default function Clients({ openClient, api = clientsApi }) {
  const [query, setQuery] = useState('')
  const [term, setTerm] = useState('')
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [adding, setAdding] = useState(false)
  // Wait for a pause in typing so each keystroke is not a request.
  useEffect(() => { const timer = setTimeout(() => setTerm(query.trim()), 250); return () => clearTimeout(timer) }, [query])
  useEffect(() => {
    let live = true
    api.search(term).then(list => { if (live) { setRows(list); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, term, attempt])
  async function create(details) {
    const created = await api.create(details, crypto.randomUUID())
    openClient(created.id)
  }
  return <section className="admin-review" aria-labelledby="clients-title">
    <header className="admin-review-heading"><div><h1 id="clients-title">Clients</h1><p>Find a client, or add someone new.</p></div></header>
    {adding ? <section aria-label="Add a client"><h2>Add a client</h2><ClientForm withAddress submitLabel="Add client" onSubmit={create} onCancel={() => setAdding(false)} /></section> : <>
      <label className="admin-field">Search by name, phone or email<input type="search" value={query} maxLength={100} onChange={event => setQuery(event.target.value)} /></label>
      <div className="admin-payment-buttons"><button onClick={() => setAdding(true)}>+ Add client</button></div>
      {error && <p role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>Try again</button></p>}
      {!rows && !error && <p role="status">Loading clients…</p>}
      {rows && !rows.length && <p>{term ? 'No one matches that search.' : 'No clients yet.'}</p>}
      {rows?.length > 0 && <ul className="admin-client-list">{rows.map(row => <li key={row.id}>
        <button onClick={() => openClient(row.id)}><strong>{fullName(row)}</strong><span>{[row.phone, row.email].filter(Boolean).join(' · ') || 'No contact details'}</span></button>
      </li>)}</ul>}
      {rows?.length === 20 && <p className="admin-detail-hint">Showing the 20 best matches. Type more of the name, phone or email to narrow it down.</p>}
    </>}
  </section>
}
