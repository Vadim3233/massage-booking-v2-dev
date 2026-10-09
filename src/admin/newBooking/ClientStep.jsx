import { useState } from 'react'
import { money } from '../calendarPresentation.js'
import { emptyAddress, clientLabel } from './presentation.js'

export function AddressFields({ details, change, prefix = 'address' }) {
  return <div className="anb-fields">
    {[['address_line_1', 'Address line 1', true], ['address_line_2', 'Address line 2', false], ['city', 'City', true], ['postcode', 'Postcode', true]].map(([key, label, required]) => <label key={key} htmlFor={`${prefix}-${key}`}>{label}{!required && ' (optional)'}<input id={`${prefix}-${key}`} required={required} value={details[key] || ''} maxLength={key === 'postcode' ? 16 : 200} autoComplete={key === 'postcode' ? 'postal-code' : 'off'} onChange={event => change({ ...details, [key]: event.target.value })} /></label>)}
    <label className="anb-wide">Entry instructions (optional)<textarea value={details.entry_instructions || ''} maxLength={1000} onChange={event => change({ ...details, entry_instructions: event.target.value })} /></label>
  </div>
}

export default function ClientStep({ draft, patch, catalogue, query, setQuery, clients, searchLoading, searchError, selectClient, addresses, addressLoading, addressError, createClient, clientBusy, clientError }) {
  const [adding, setAdding] = useState(false)
  const newClient = draft.newClient || { first_name: '', last_name: '', phone: '', email: '', ...emptyAddress }
  const setNewClient = value => patch({ newClient: value })
  const [contactError, setContactError] = useState('')
  const area = catalogue.areas.find(item => item.id === draft.areaId)
  async function add(event) {
    event.preventDefault()
    if (!newClient.phone.trim() && !newClient.email.trim()) { setContactError('Enter a phone number or email address.'); return }
    setContactError('')
    if (await createClient(newClient)) { patch({ newClient: null }); setAdding(false) }
  }
  return <>
    {!adding && <>
      <label>Find a client<input type="search" value={query} placeholder="Name, phone or email" autoComplete="off" maxLength={160} onChange={event => setQuery(event.target.value)} /></label>
      {searchLoading && <p role="status">Finding clients…</p>}
      {searchError && <p role="alert">{searchError}</p>}
      <ul className="anb-client-list" aria-label={query ? 'Matching clients' : 'Recent clients'}>{clients.map(client => <li key={client.id}><button type="button" aria-pressed={draft.client?.id === client.id} onClick={() => selectClient(client)}><strong>{clientLabel(client)}</strong><span>{[client.phone, client.email].filter(Boolean).join(' · ')}</span></button></li>)}</ul>
      {!searchLoading && !searchError && !clients.length && <p>No matching clients.</p>}
      <button type="button" onClick={() => setAdding(true)}>+ Add new client</button>
    </>}
    {adding && <form className="anb-inline-client" onSubmit={add}>
      <h3>Add new client</h3><div className="anb-fields">
        {[['first_name', 'First name', 'text'], ['last_name', 'Last name (optional)', 'text'], ['phone', 'Phone', 'tel'], ['email', 'Email', 'email']].map(([key, label, type]) => <label key={key}>{label}<input required={key === 'first_name'} type={type} value={newClient[key]} maxLength={key === 'email' ? 254 : 120} onChange={event => setNewClient({ ...newClient, [key]: event.target.value })} /></label>)}
      </div><p className="anb-hint">A phone number or email is required. This address becomes the client’s default.</p>
      {contactError && <p role="alert">{contactError}</p>}
      <AddressFields details={newClient} change={setNewClient} prefix="new-client" />
      {clientError && <p role="alert">{clientError}</p>}
      <div className="anb-inline-actions"><button type="button" disabled={clientBusy} onClick={() => setAdding(false)}>Back to client search</button><button className="anb-primary" disabled={clientBusy}>{clientBusy ? 'Saving client…' : 'Save client'}</button></div>
    </form>}
    {draft.client && <section className="anb-section"><h3>{clientLabel(draft.client)}</h3><p className="anb-hint">{[draft.client.phone, draft.client.email].filter(Boolean).join(' · ')}</p>
      {addressLoading && <p role="status">Loading saved addresses…</p>}{addressError && <p role="alert">{addressError}</p>}
      <fieldset><legend>Appointment address</legend>{addresses.map(address => <label className="anb-radio" key={address.id}><input type="radio" name="booking-address" checked={draft.details.savedAddressId === address.id} onChange={() => patch({ details: { ...emptyAddress, ...address, savedAddressId: address.id } })} /><span>{address.address_line_1}, {address.postcode}{address.is_default ? ' · Default' : ''}</span></label>)}
      <label className="anb-radio"><input type="radio" name="booking-address" checked={!draft.details.savedAddressId} onChange={() => patch({ details: { ...emptyAddress } })} /><span>One-off booking address</span></label></fieldset>
      {!draft.details.savedAddressId ? <AddressFields details={draft.details} change={details => patch({ details })} /> : <address>{[draft.details.address_line_1, draft.details.address_line_2, draft.details.city, draft.details.postcode].filter(Boolean).join(', ')}{draft.details.entry_instructions && <p>{draft.details.entry_instructions}</p>}</address>}
      <label>Service area<select required value={draft.areaId} onChange={event => patch({ areaId: event.target.value })}><option value="">Select service area</option>{catalogue.areas.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {area && <p className="anb-hint">Travel {money(area.travel_surcharge_gbp)} · Congestion {money(area.congestion_fee_gbp)}</p>}
    </section>}
  </>
}
