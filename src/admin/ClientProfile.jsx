import { useEffect, useState } from 'react'
import { clientsApi, fullName } from './clientsApi.js'
import { AddressForm, ClientForm } from './ClientForms.jsx'
import { clientContactLinks } from './contactLinks.js'
import { dateLabel, label, money, time } from './calendarPresentation.js'

const PAGE = 15
const stamp = value => new Date(value).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' })

function Summary({ clientId, api, version }) {
  const [summary, setSummary] = useState(null)
  useEffect(() => {
    let live = true
    api.summary(clientId).then(value => { if (live) setSummary(value) }, () => { if (live) setSummary(false) })
    return () => { live = false }
  }, [api, clientId, version])
  if (summary === null) return <p role="status">Loading…</p>
  if (summary === false) return <p>Could not load the summary.</p>
  const next = summary.next_booking
  return <dl className="admin-client-summary">
    <div><dt>Visits</dt><dd>{summary.completed_visits}</dd></div>
    <div><dt>Paid so far</dt><dd>{money(summary.paid_gbp)}</dd></div>
    <div><dt>Upcoming</dt><dd>{summary.upcoming}</dd></div>
    <div><dt>Last visit</dt><dd>{summary.last_visit ? dateLabel(summary.last_visit, { day: 'numeric', month: 'short', year: 'numeric' }) : 'None yet'}</dd></div>
    <div className="wide"><dt>Next appointment</dt><dd>{next ? `${dateLabel(next.date, { weekday: 'short', day: 'numeric', month: 'short' })} at ${time(next.start_minutes)}` : 'None booked'}</dd></div>
    {Number(summary.late_fees_due_gbp) > 0 && <div className="wide owed"><dt>Late fees due</dt><dd>{money(summary.late_fees_due_gbp)}</dd></div>}
    {Number(summary.refunds_due_gbp) > 0 && <div className="wide owed"><dt>Refunds to send</dt><dd>{money(summary.refunds_due_gbp)}</dd></div>}
  </dl>
}

function Addresses({ clientId, api, changed }) {
  const [list, setList] = useState(null)
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)
  const [editing, setEditing] = useState(null)
  const [removing, setRemoving] = useState(null)
  useEffect(() => {
    let live = true
    api.addresses(clientId).then(rows => { if (live) { setList(rows); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, clientId, version])
  const refresh = () => { setEditing(null); setRemoving(null); setVersion(value => value + 1); changed() }
  const act = async work => { setError(''); try { await work(); refresh() } catch (failure) { setError(failure.message) } }
  return <section aria-labelledby="addresses-title"><h2 id="addresses-title">Addresses</h2>
    {error && <p role="alert">{error}</p>}
    {!list && !error && <p role="status">Loading addresses…</p>}
    {list && !list.length && editing !== 'new' && <p>No saved addresses yet.</p>}
    {list?.length > 0 && <ul className="admin-address-list">{list.map(item => <li key={item.id}>
      {editing === item.id
        ? <AddressForm initial={item} submitLabel="Save address" onSubmit={address => api.updateAddress(item.id, address).then(refresh)} onCancel={() => setEditing(null)} />
        : <>
          <address>{[item.address_line_1, item.address_line_2, item.city, item.postcode].filter(Boolean).join(', ')}{item.entry_instructions && <small>{item.entry_instructions}</small>}</address>
          <p className="admin-detail-hint">{[item.label, item.is_default ? 'Default' : null].filter(Boolean).join(' · ')}</p>
          {removing === item.id
            ? <div role="alert" className="admin-conflicts"><p>Remove this address? Past bookings keep their own copy of it.</p>
                <div className="admin-payment-buttons"><button onClick={() => setRemoving(null)}>Keep it</button><button onClick={() => act(() => api.deleteAddress(item.id))}>Yes, remove</button></div></div>
            : <div className="admin-payment-buttons">
                <button onClick={() => setEditing(item.id)}>Change</button>
                {!item.is_default && <button onClick={() => act(() => api.setDefaultAddress(clientId, item.id))}>Make default</button>}
                <button onClick={() => setRemoving(item.id)}>Remove</button>
              </div>}
        </>}
    </li>)}</ul>}
    {editing === 'new'
      ? <AddressForm submitLabel="Add address" onSubmit={address => api.addAddress(clientId, address).then(refresh)} onCancel={() => setEditing(null)} />
      : <button onClick={() => setEditing('new')}>+ Add address</button>}
  </section>
}

function Notes({ clientId, api }) {
  const [notes, setNotes] = useState(null)
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let live = true
    api.notes(clientId).then(rows => { if (live) { setNotes(rows); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, clientId, version])
  async function add(event) {
    event.preventDefault()
    if (busy || !text.trim()) return
    setBusy(true); setError('')
    try { await api.addNote(clientId, text); setText(''); setVersion(value => value + 1) } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  async function remove(id) {
    try { await api.deleteNote(id); setVersion(value => value + 1) } catch (failure) { setError(failure.message) }
  }
  return <section aria-labelledby="notes-title"><h2 id="notes-title">Notes</h2>
    <p className="admin-detail-hint">Only you see these: pressure, areas to focus on, access, anything worth remembering.</p>
    <form className="admin-note-form" onSubmit={add}>
      <label className="admin-field">Add a note<textarea rows={3} maxLength={2000} value={text} disabled={busy} onChange={event => setText(event.target.value)} /></label>
      <button type="submit" disabled={busy || !text.trim()}>{busy ? 'Saving…' : 'Save note'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {notes && !notes.length && <p>No notes yet.</p>}
    {notes?.length > 0 && <ul className="admin-note-list">{notes.map(note => <li key={note.id}><p>{note.note}</p><small>{stamp(note.created_at)}</small><button aria-label={`Delete the note from ${stamp(note.created_at)}`} onClick={() => remove(note.id)}>Delete</button></li>)}</ul>}
  </section>
}

function History({ clientId, api, openBooking, version }) {
  const [rows, setRows] = useState(null)
  const [more, setMore] = useState(false)
  const [error, setError] = useState('')
  const [pages, setPages] = useState(1)
  useEffect(() => {
    let live = true
    api.bookings(clientId, 0, pages * PAGE).then(list => { if (live) { setMore(list.length > pages * PAGE); setRows(list.slice(0, pages * PAGE)); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, clientId, pages, version])
  return <section aria-labelledby="history-title"><h2 id="history-title">Bookings</h2>
    {error && <p role="alert">{error}</p>}
    {!rows && !error && <p role="status">Loading bookings…</p>}
    {rows && !rows.length && <p>No bookings yet.</p>}
    {rows?.length > 0 && <ul className="admin-client-bookings">{rows.map(row => <li key={row.id}><button onClick={() => openBooking(row.id)}>
      <strong>{dateLabel(row.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} · {time(row.start_minutes)}</strong>
      <span>{[...(row.booking_sessions || [])].sort((a, b) => a.position - b.position).map(item => item.service_name_snapshot).join(', ') || 'Massage'} · {row.treatment_duration_minutes} min · {money(row.total_gbp)}</span>
      <span className="admin-detail-hint">{label(row.booking_status)}{row.booking_payments ? ` · ${label(row.booking_payments.status)}` : ''}{row.late_fee_status === 'due' ? ` · Late fee ${money(row.late_fee_due_gbp)} due` : ''}{Number(row.refund_due_gbp) > 0 ? ` · Refund ${money(row.refund_due_gbp)} to send` : ''}</span>
    </button></li>)}</ul>}
    {more && <button onClick={() => setPages(value => value + 1)}>Show more</button>}
  </section>
}

export default function ClientProfile({ id, back, openBooking, newBooking, api = clientsApi }) {
  const [client, setClient] = useState(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    api.get(id).then(row => { if (live) { setClient(row || false); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, id, version])
  const changed = () => setVersion(value => value + 1)
  async function toggleOnline() {
    setBusy(true); setError('')
    try { await api.setOnlineBooking(id, !client.online_booking_enabled); changed() } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  if (error && !client) return <section className="admin-review"><p role="alert">{error}</p><button onClick={changed}>Try again</button><button onClick={back}>Back to Clients</button></section>
  if (client === false) return <section className="admin-review"><p>That client could not be found.</p><button onClick={back}>Back to Clients</button></section>
  if (!client) return <section className="admin-review"><p role="status">Loading client…</p></section>
  return <section className="admin-review admin-client-profile" aria-labelledby="client-name">
    <button className="admin-back-link" onClick={back}>← Clients</button>
    <h1 id="client-name">{fullName(client)}</h1>
    <p>{[client.phone, client.email].filter(Boolean).join(' · ') || 'No contact details'}</p>
    <nav className="admin-contact-actions" aria-label="Quick contact">{clientContactLinks(client).map(link => <a key={link.key} href={link.href} {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{link.label}</a>)}</nav>
    <div className="admin-payment-buttons"><button onClick={() => newBooking(client.id)}>+ New booking</button><button onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Edit details'}</button></div>
    {editing && <section aria-label="Edit details"><ClientForm initial={client} submitLabel="Save details" onCancel={() => setEditing(false)} onSubmit={async details => { await api.update(id, details); setEditing(false); changed() }} /></section>}
    {error && <p role="alert">{error}</p>}
    <Summary clientId={id} api={api} version={version} />
    <section aria-labelledby="online-title"><h2 id="online-title">Online booking</h2>
      <p>{client.online_booking_enabled ? 'This client can book online.' : 'Online booking is switched off for this client. They cannot book on the website.'}</p>
      <button disabled={busy} onClick={toggleOnline}>{client.online_booking_enabled ? 'Switch off online booking' : 'Switch on online booking'}</button>
      <p className="admin-detail-hint">{client.auth_user_id ? 'Has an online account.' : 'No online account yet.'} Client since {stamp(client.created_at)}.</p>
    </section>
    <Addresses clientId={id} api={api} changed={changed} />
    <Notes clientId={id} api={api} />
    <History clientId={id} api={api} openBooking={openBooking} version={version} />
  </section>
}
