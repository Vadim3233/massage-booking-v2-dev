import { useEffect, useRef, useState } from 'react'
import Icon from '../ui/icons.jsx'
import { clientsApi, fullName } from './clientsApi.js'
import { AddressForm, ClientForm } from './ClientForms.jsx'
import { clientContactLinks } from './contactLinks.js'
import { phoneProblem } from '../lib/phone.js'
import { bookingState, dateLabel, money, time } from './calendarPresentation.js'
import ClientRepeats from './ClientRepeats.jsx'
import ClientRhythm from './ClientRhythm.jsx'
import { activityApi } from './activityApi.js'
import ClientTelegram from './ClientTelegram.jsx'
import ClientGiftVoucher from './ClientGiftVoucher.jsx'
import ClientPaymentReminder from './ClientPaymentReminder.jsx'
import { stayedLongerCount } from './extendApi.js'
import CombinePicker from './CombinePicker.jsx'
import DeleteClient from './DeleteClient.jsx'
import { deletedMessage } from './clientDelete.js'
import { toast } from '../ui/toast.js'
import { travelFeeApi, travelFeeBlock, travelFeeOutcome } from './travelFeeApi.js'

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
    {list?.length > 0 && <ul role="list" className="admin-address-list">{list.map(item => <li key={item.id}>
      {editing === item.id
        ? <AddressForm initial={item} submitLabel="Save address" onSubmit={address => api.updateAddress(item.id, address).then(refresh)} onCancel={() => setEditing(null)} />
        : <>
          <address>{item.address}{item.entry_instructions && <small>{item.entry_instructions}</small>}</address>
          <p className="admin-detail-hint">{[item.label, item.is_default ? 'Default' : null].filter(Boolean).join(' · ')}</p>
          {removing === item.id
            ? <div role="alert" className="admin-conflicts"><p>Remove this address? Past bookings keep their own copy of it.</p>
                <div className="admin-payment-buttons"><button onClick={() => setRemoving(null)}>Keep it</button><button className="btn--danger-solid" onClick={() => act(() => api.deleteAddress(item.id))}>Yes, remove</button></div></div>
            : <div className="admin-payment-buttons">
                <button className="btn--small" onClick={() => setEditing(item.id)}>Change</button>
                {!item.is_default && <button className="btn--small" onClick={() => act(() => api.setDefaultAddress(clientId, item.id))}>Make default</button>}
                <button className="btn--small btn--danger" onClick={() => setRemoving(item.id)}>Remove</button>
              </div>}
        </>}
    </li>)}</ul>}
    {editing === 'new'
      ? <AddressForm submitLabel="Add address" onSubmit={address => api.addAddress(clientId, address).then(refresh)} onCancel={() => setEditing(null)} />
      : <button className="btn--tonal" onClick={() => setEditing('new')}>+ Add address</button>}
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
      <button type="submit" className="btn--primary" disabled={busy || !text.trim()}>{busy ? 'Saving…' : 'Save note'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {notes && !notes.length && <p>No notes yet.</p>}
    {notes?.length > 0 && <ul role="list" className="admin-note-list">{notes.map(note => <li key={note.id}><p>{note.note}</p><small>{stamp(note.created_at)}</small><button aria-label={`Delete the note from ${stamp(note.created_at)}`} className="btn--small btn--danger" onClick={() => remove(note.id)}>Delete</button></li>)}</ul>}
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
    {rows?.length > 0 && <ul role="list" className="admin-client-bookings">{rows.map(row => { const state = bookingState(row); const owing = [row.late_fee_status === 'due' ? `Late fee ${money(row.late_fee_due_gbp)} due` : '', Number(row.refund_due_gbp) > 0 ? `Refund ${money(row.refund_due_gbp)} to send` : ''].filter(Boolean).join(' · ')
      return <li key={row.id}><button onClick={() => openBooking(row.id)} data-variant={state.variant}>
      <strong>{dateLabel(row.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} · {time(row.start_minutes)}</strong>
      <span>{[...(row.booking_sessions || [])].sort((a, b) => a.position - b.position).map(item => item.service_name_snapshot).join(', ') || 'Massage'} · {row.treatment_duration_minutes} min · {money(row.total_gbp)}</span>
      <span className={`chip chip--${state.chip} admin-status ${state.tone}`}>{state.text}</span>
      {owing && <span className="admin-detail-hint">{owing}</span>}
    </button></li> })}</ul>}
    {more && <button className="btn--tonal" onClick={() => setPages(value => value + 1)}>Show more</button>}
  </section>
}

// Cash is for returning clients (a completed, paid visit). A new client pays by bank transfer before the first visit is confirmed,
// unless Vadim marks them Trusted here, for example someone a client of his recommended (20261209100000_new_clients_pay_by_transfer.sql).
function CashTrust({ clientId, api, version }) {
  const [trust, setTrust] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!api.paymentTrust) return undefined
    let live = true
    api.paymentTrust(clientId).then(row => { if (live) setTrust(row || null) }, () => { if (live) setTrust(null) })
    return () => { live = false }
  }, [api, clientId, version])
  if (!trust) return null
  async function toggle() {
    setBusy(true); setError('')
    try { await api.setCashTrusted(clientId, !trust.trusted); setTrust({ ...trust, trusted: !trust.trusted }) } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  const sentence = trust.has_paid_visit ? 'Returning client: can pay by bank transfer or cash.'
    : trust.trusted ? 'Trusted: can pay cash, even before their first visit.'
      : 'New client: pays by bank transfer to secure their first visit. Cash is offered from their second visit.'
  return <section aria-labelledby="cash-title"><h2 id="cash-title">Paying</h2>
    <p>{sentence}</p>
    {!trust.has_paid_visit && <button className="btn--small" disabled={busy} aria-pressed={Boolean(trust.trusted)} onClick={toggle}>{trust.trusted ? 'Not trusted: bank transfer first' : 'Trusted, allow cash'}</button>}
    {error && <p role="alert">{error}</p>}
  </section>
}

// "Stayed longer 3 times": a client who often asks for extra time may like a longer session next time. Nothing shows until it has happened twice.
function StayedLonger({ clientId, api, version }) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let live = true
    if (!api.stayedLonger) return undefined
    api.stayedLonger(clientId).then(rows => { if (live) setCount(stayedLongerCount((rows || []).filter(row => !['cancelled', 'no_show'].includes(row.bookings?.booking_status)))) }, () => { if (live) setCount(0) })
    return () => { live = false }
  }, [api, clientId, version])
  if (count < 2) return null
  return <p className="admin-stayed-longer" role="status">Stayed longer {count} times. Next time, you could offer a longer session.</p>
}

// "Moved 3 of their last 5 bookings" (ADR-107): a client who often asks to move. Nothing shows until it has happened twice.
function MovedOften({ clientId, version, api = activityApi }) {
  const [moves, setMoves] = useState(null)
  useEffect(() => {
    let live = true
    api.clientMoves(clientId).then(value => { if (live) setMoves(value) }, () => { if (live) setMoves(null) })
    return () => { live = false }
  }, [api, clientId, version])
  if (!moves || moves.moved < 2) return null
  return <p className="admin-stayed-longer" role="status">Moved {moves.moved} of their last {moves.of} bookings. You may want to confirm the time with them a day before.</p>
}

// While "No travel fee" is on: their upcoming bookings that still have a travel fee (made before it was switched on), each ticked, with
// "Remove the travel fee" for the ticked ones (20261225100000_remove_travel_fee.sql). One booking that cannot change does not stop the others.
function UpcomingTravelFees({ clientId, version, changed, api = travelFeeApi }) {
  const [rows, setRows] = useState(null)
  const [ticked, setTicked] = useState({})
  const [notify, setNotify] = useState(true)
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState([])
  const [loadError, setLoadError] = useState('')
  const requests = useRef({})
  useEffect(() => {
    let live = true
    api.upcoming(clientId).then(list => {
      if (!live) return
      setRows(list); setLoadError('')
      setTicked(Object.fromEntries(list.map(row => [row.id, travelFeeBlock(row) === ''])))
    }, failure => { if (live) { setRows([]); setLoadError(failure.message) } })
    return () => { live = false }
  }, [api, clientId, version])
  if (loadError) return <p role="alert">{loadError}</p>
  if (!rows?.length) return null
  const chosen = rows.filter(row => ticked[row.id] && travelFeeBlock(row) === '')
  async function removeAll() {
    if (busy || !chosen.length) return
    setBusy(true); setProblems([])
    const failed = []
    let removed = 0
    for (const row of chosen) {
      const key = `${row.id}|${row.updated_at}|${notify}`
      if (requests.current[row.id]?.key !== key) requests.current[row.id] = { key, id: crypto.randomUUID() }
      try { await api.remove(row, requests.current[row.id].id, notify); removed += 1 } catch (failure) { failed.push(`${dateLabel(row.date)} ${time(row.start_minutes)}: ${failure.message}`) }
    }
    setProblems(failed)
    setBusy(false)
    if (removed) toast(`Travel fee removed from ${removed} ${removed === 1 ? 'booking' : 'bookings'}`)
    changed()
  }
  return <div className="admin-travel-fee-ask" role="group" aria-labelledby="upcoming-fees-title">
    <h4 id="upcoming-fees-title">{rows.length === 1 ? 'Their upcoming booking still has a travel fee' : `Their ${rows.length} upcoming bookings still have a travel fee`}</h4>
    <p className="admin-detail-hint">They were made before you switched this on. Remove it from these too?</p>
    <ul role="list" className="admin-travel-fee-list">{rows.map(row => {
      const block = travelFeeBlock(row)
      return <li key={row.id}>
        <label className="admin-who-row"><input type="checkbox" checked={Boolean(ticked[row.id]) && !block} disabled={busy || Boolean(block)} onChange={event => setTicked(value => ({ ...value, [row.id]: event.target.checked }))} />
          <span>{dateLabel(row.date)} · {time(row.start_minutes)} · {money(row.travel_fee_gbp)} travel{row.service_area_name_snapshot ? ` (${row.service_area_name_snapshot})` : ''}</span></label>
        <p className="admin-detail-hint">{block || travelFeeOutcome(row).text}</p>
      </li>
    })}</ul>
    <label className="admin-who-row"><input type="checkbox" checked={notify} disabled={busy} onChange={event => setNotify(event.target.checked)} /> Send the client the new price</label>
    {problems.map(line => <p key={line} role="alert">{line}</p>)}
    <div className="admin-payment-buttons"><button className="btn--primary btn--small" disabled={busy || !chosen.length} onClick={removeAll}>{busy ? 'Removing…' : chosen.length > 1 ? `Remove the travel fee from ${chosen.length} bookings` : 'Remove the travel fee'}</button></div>
  </div>
}

export default function ClientProfile({ id, back, backLabel = 'Clients', openBooking, newBooking, openCombine, onDeleted, api = clientsApi }) {
  const [client, setClient] = useState(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [combining, setCombining] = useState(false)
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
  async function toggleTravelFee() {
    setBusy(true); setError('')
    try { await api.setNoTravelFee(id, !client.no_travel_fee); changed() } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  async function toggleMinimum() {
    setBusy(true); setError('')
    try { await api.setNoMinimumBooking(id, !client.no_minimum_booking); changed() } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  if (error && !client) return <section className="admin-review"><p role="alert">{error}</p><button onClick={changed}>Try again</button><button onClick={back}>Back to Clients</button></section>
  if (client === false) return <section className="admin-review"><p>That client could not be found.</p><button onClick={back}>Back to Clients</button></section>
  if (!client) return <section className="admin-review"><p role="status">Loading client…</p></section>
  const contactLinks = clientContactLinks(client)
  return <section className="admin-review admin-client-profile" aria-labelledby="client-name">
    <button className="admin-back-link" onClick={back}>← {backLabel}</button>
    <h1 id="client-name">{fullName(client)}</h1>
    <p>{[client.phone, client.email].filter(Boolean).join(' · ') || 'No contact details'}</p>
    {phoneProblem(client.phone) && !editing && <p role="status" className="admin-field-error">This phone number looks wrong. {phoneProblem(client.phone)} Press Edit details to correct it.</p>}
    {contactLinks.length > 0 && <nav className="admin-contact-actions" aria-label="Quick contact">{contactLinks.map(link => <a key={link.key} href={link.href} {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}><Icon name={link.icon} />{link.label}</a>)}</nav>}
    <div className="admin-payment-buttons"><button className="btn--primary" onClick={() => newBooking(client.id)}>+ New booking</button><button className="btn--tonal" onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Edit details'}</button></div>
    {editing && <section aria-label="Edit details"><ClientForm initial={client} submitLabel="Save details" onCancel={() => setEditing(false)} onSubmit={async details => { await api.update(id, details); setEditing(false); changed() }} /></section>}
    {error && <p role="alert">{error}</p>}
    <Summary clientId={id} api={api} version={version} />
    <ClientRhythm client={client} api={api} version={version} newBooking={newBooking} />
    <StayedLonger clientId={id} api={api} version={version} />
    <MovedOften clientId={id} version={version} />
    <ClientPaymentReminder key={`reminder-${client.id}`} client={client} api={api} version={version} />
    <History clientId={id} api={api} openBooking={openBooking} version={version} />
    <Notes clientId={id} api={api} />
    <ClientRepeats clientId={id} openBooking={openBooking} />
    <Addresses clientId={id} api={api} changed={changed} />
    <ClientTelegram key={`telegram-${client.id}`} client={client} api={api} />
    <ClientGiftVoucher key={`gift-${client.id}`} client={client} />
    <section aria-labelledby="online-title"><h2 id="online-title">Online booking</h2>
      <p>{client.online_booking_enabled ? 'This client can book online.' : 'Online booking is switched off for this client. They cannot book on the website.'}</p>
      <button className="btn--small" disabled={busy} onClick={toggleOnline}>{client.online_booking_enabled ? 'Switch off online booking' : 'Switch on online booking'}</button>
      <p className="admin-detail-hint">{client.auth_user_id ? 'Has an online account.' : 'No online account yet.'} Client since {stamp(client.created_at)}.</p>
    </section>
    <section aria-labelledby="prices-title"><h2 id="prices-title">Prices</h2>
      <p>{client.no_travel_fee ? 'No travel fee: this client\'s new bookings have no travel fee, whoever makes them. The congestion charge still applies.' : 'This client pays the travel fee for their area.'}</p>
      <button className="btn--small" disabled={busy} aria-pressed={Boolean(client.no_travel_fee)} onClick={toggleTravelFee}>{client.no_travel_fee ? 'Charge the travel fee again' : 'No travel fee for this client'}</button>
      {client.no_travel_fee
        ? <UpcomingTravelFees clientId={id} version={version} changed={changed} />
        : <p className="admin-detail-hint">Bookings already made keep their price. When you switch this on, you can remove the travel fee from their upcoming bookings too.</p>}
      <p>{client.no_minimum_booking ? 'No minimum booking: this client can book any length in any area.' : 'This client keeps to each area\'s minimum booking (More > Areas).'}</p>
      <button className="btn--small" disabled={busy} aria-pressed={Boolean(client.no_minimum_booking)} onClick={toggleMinimum}>{client.no_minimum_booking ? 'Use the area minimums again' : 'No minimum booking for this client'}</button>
    </section>
    <CashTrust key={`cash-${client.id}`} clientId={id} api={api} version={version} />
    {openCombine && <section aria-labelledby="same-title"><h2 id="same-title">Same person twice?</h2>
      <p className="admin-detail-hint">If this client also appears as another entry, for example one made when they booked as a guest, you can look at the two side by side and combine them.</p>
      {combining
        ? <CombinePicker clientId={id} openCombine={openCombine} close={() => setCombining(false)} api={api} />
        : <button className="btn--tonal" onClick={() => setCombining(true)}>Combine with another client…</button>}
    </section>}
    <DeleteClient client={client} api={api} deleted={name => { toast(deletedMessage(name)); onDeleted?.(id); back() }} />
  </section>
}
