import { useState } from 'react'
import { money } from '../calendarPresentation.js'
import { emptyAddress, clientLabel, initials } from './presentation.js'
import { addressTyped, validateClient, validateOptionalAddress } from '../clientsApi.js'

// `optional` is for an address that may be left out altogether (a new client's), where the three parts are not each required.
export function AddressFields({ details, change, prefix = 'address', optional = false }) {
  return <div className="anb-fields">
    {[['address_line_1', 'Address line 1', true], ['address_line_2', 'Address line 2', false], ['city', 'City', true], ['postcode', 'Postcode', true]].map(([key, label, required]) => <label key={key} htmlFor={`${prefix}-${key}`}>{label}{!required && ' (optional)'}<input id={`${prefix}-${key}`} required={required && !optional} value={details[key] || ''} maxLength={key === 'postcode' ? 16 : 200} autoComplete={key === 'postcode' ? 'postal-code' : 'off'} onChange={event => change({ ...details, [key]: event.target.value })} /></label>)}
    <label className="anb-wide">Entry instructions (optional)<textarea value={details.entry_instructions || ''} maxLength={1000} onChange={event => change({ ...details, entry_instructions: event.target.value })} /></label>
  </div>
}

export default function ClientStep({ draft, patch, catalogue, query, setQuery, clients, searchLoading, searchError, selectClient, addresses, addressLoading, addressError, createClient, clientBusy, clientError }) {
  const [adding, setAdding] = useState(false)
  const [changing, setChanging] = useState(false)
  const searching = !draft.client || changing
  const newClient = draft.newClient || { first_name: '', last_name: '', phone: '', email: '', ...emptyAddress }
  const setNewClient = value => patch({ newClient: value })
  const [formError, setFormError] = useState('')
  const area = catalogue.areas.find(item => item.id === draft.areaId)
  async function add(event) {
    event.preventDefault()
    // Only the name is needed. An address is optional as a whole; if one is started it needs the street, city and postcode.
    const problem = validateClient(newClient) || validateOptionalAddress(newClient)
    if (problem) { setFormError(problem); return }
    setFormError('')
    // Nothing typed for the address (the city is filled in with London) means a client with no address yet.
    const details = addressTyped(newClient) ? newClient : { first_name: newClient.first_name, last_name: newClient.last_name, phone: newClient.phone, email: newClient.email }
    if (await createClient(details)) { patch({ newClient: null }); setAdding(false) }
  }
  return <>
    {!adding && searching && <>
      <label>Find a client<input type="search" value={query} placeholder="Name, phone or email" autoComplete="off" maxLength={160} onChange={event => setQuery(event.target.value)} /></label>
      {searchLoading && <p role="status">Finding clients…</p>}
      {searchError && <p role="alert">{searchError}</p>}
      <ul role="list" className="anb-client-list" aria-label={query ? 'Matching clients' : 'Recent clients'}>{clients.slice(0, query ? 8 : 5).map(client => <li key={client.id}><button type="button" className="anb-client" aria-pressed={draft.client?.id === client.id} onClick={() => { selectClient(client); setChanging(false) }}><span className="monogram" aria-hidden="true">{initials(client)}</span><span className="anb-client-text"><strong>{clientLabel(client)}</strong><span>{[client.phone, client.email].filter(Boolean).join(' · ')}</span></span></button></li>)}</ul>
      {!searchLoading && !searchError && clients.length > (query ? 8 : 5) && <p className="anb-hint">Showing {query ? 8 : 5} of {clients.length}. Type a name, phone or email to find the rest.</p>}
      {!searchLoading && !searchError && !clients.length && <p>No matching clients.</p>}
      <button type="button" className="btn--tonal" onClick={() => setAdding(true)}>+ Add new client</button>
    </>}
    {adding && <form className="anb-inline-client" onSubmit={add}>
      <h3>Add new client</h3><div className="anb-fields">
        {[['first_name', 'First name', 'text'], ['last_name', 'Last name (optional)', 'text'], ['phone', 'Phone', 'tel'], ['email', 'Email', 'email']].map(([key, label, type]) => <label key={key}>{label}<input required={key === 'first_name'} type={type} value={newClient[key]} maxLength={key === 'email' ? 254 : 120} onChange={event => setNewClient({ ...newClient, [key]: event.target.value })} /></label>)}
      </div><p className="anb-hint">Only the name is needed. Phone, email and address are optional; an address you enter becomes the client’s default.</p>
      {formError && <p role="alert">{formError}</p>}
      <AddressFields details={newClient} change={setNewClient} prefix="new-client" optional />
      {clientError && <p role="alert">{clientError}</p>}
      <div className="anb-inline-actions"><button type="button" disabled={clientBusy} onClick={() => setAdding(false)}>Back to client search</button><button className="btn--primary" disabled={clientBusy}>{clientBusy ? 'Saving client…' : 'Save client'}</button></div>
    </form>}
    {draft.client && !adding && <section className="anb-section"><div className="anb-chosen"><span className="monogram monogram--large" aria-hidden="true">{initials(draft.client)}</span><div className="anb-client-text"><h3>{clientLabel(draft.client)}</h3><p className="anb-hint">{[draft.client.phone, draft.client.email].filter(Boolean).join(' · ')}</p></div>{!changing && <button type="button" className="btn--quiet btn--small" onClick={() => setChanging(true)}>Change client</button>}</div>
      {addressLoading && <p role="status">Loading saved addresses…</p>}{addressError && <p role="alert">{addressError}</p>}
      <fieldset><legend>Appointment address</legend>{addresses.map(address => <label className="anb-radio" key={address.id}><input type="radio" name="booking-address" checked={draft.details.savedAddressId === address.id} onChange={() => patch({ details: { ...emptyAddress, ...address, savedAddressId: address.id } })} /><span>{address.address_line_1}, {address.postcode}{address.is_default ? ' · Default' : ''}</span></label>)}
      <label className="anb-radio"><input type="radio" name="booking-address" checked={!draft.details.savedAddressId} onChange={() => patch({ details: { ...emptyAddress } })} /><span>One-off booking address</span></label></fieldset>
      {!draft.details.savedAddressId ? <AddressFields details={draft.details} change={details => patch({ details })} /> : <address>{[draft.details.address_line_1, draft.details.address_line_2, draft.details.city, draft.details.postcode].filter(Boolean).join(', ')}{draft.details.entry_instructions && <p>{draft.details.entry_instructions}</p>}</address>}
      <label>Service area<select required value={draft.areaId} onChange={event => patch({ areaId: event.target.value })}><option value="">Select service area</option>{catalogue.areas.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {area && <p className="anb-hint">Travel {money(area.travel_surcharge_gbp)} · Congestion {money(area.congestion_fee_gbp)}</p>}
    </section>}
  </>
}
