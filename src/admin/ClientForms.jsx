import { useState } from 'react'
import { validateAddress, validateClient } from './clientsApi.js'

const EMPTY_ADDRESS = { label: '', address_line_1: '', address_line_2: '', city: 'London', postcode: '', entry_instructions: '' }

export function AddressFields({ value, onChange, disabled }) {
  const set = patch => onChange({ ...value, ...patch })
  return <>
    <label className="admin-field">Street and number<input value={value.address_line_1} maxLength={200} autoComplete="street-address" disabled={disabled} onChange={event => set({ address_line_1: event.target.value })} /></label>
    <label className="admin-field">Flat or building (optional)<input value={value.address_line_2 || ''} maxLength={200} disabled={disabled} onChange={event => set({ address_line_2: event.target.value })} /></label>
    <div className="admin-hours-fields">
      <label className="admin-field">City<input value={value.city} maxLength={100} disabled={disabled} onChange={event => set({ city: event.target.value })} /></label>
      <label className="admin-field">Postcode<input value={value.postcode} maxLength={12} autoComplete="postal-code" disabled={disabled} onChange={event => set({ postcode: event.target.value })} /></label>
    </div>
    <label className="admin-field">Entry instructions (optional)<input value={value.entry_instructions || ''} maxLength={300} disabled={disabled} onChange={event => set({ entry_instructions: event.target.value })} /></label>
    <label className="admin-field">Label (optional, for example Home or Office)<input value={value.label || ''} maxLength={60} disabled={disabled} onChange={event => set({ label: event.target.value })} /></label>
  </>
}

// Details for a client, with an address when adding someone new. The server checks everything again.
export function ClientForm({ initial, withAddress, submitLabel, onSubmit, onCancel }) {
  // Only the four contact fields are ever sent; the screen may be given a whole client record.
  const [details, setDetails] = useState({ first_name: initial?.first_name || '', last_name: initial?.last_name || '', phone: initial?.phone || '', email: initial?.email || '' })
  const [address, setAddress] = useState(EMPTY_ADDRESS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const problem = validateClient(details) || (withAddress ? validateAddress(address) : '')
  async function submit(event) {
    event.preventDefault()
    if (busy || problem) return
    setBusy(true); setError('')
    try { await onSubmit(withAddress ? { ...details, address_line_1: address.address_line_1, address_line_2: address.address_line_2, city: address.city, postcode: address.postcode, entry_instructions: address.entry_instructions } : details) }
    catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  const set = patch => setDetails({ ...details, ...patch })
  return <form className="admin-client-form" onSubmit={submit}>
    <div className="admin-hours-fields">
      <label className="admin-field">First name<input value={details.first_name} maxLength={120} autoComplete="given-name" disabled={busy} onChange={event => set({ first_name: event.target.value })} /></label>
      <label className="admin-field">Last name<input value={details.last_name || ''} maxLength={120} autoComplete="family-name" disabled={busy} onChange={event => set({ last_name: event.target.value })} /></label>
    </div>
    <label className="admin-field">Phone<input type="tel" value={details.phone || ''} maxLength={30} autoComplete="tel" disabled={busy} onChange={event => set({ phone: event.target.value })} /></label>
    <label className="admin-field">Email<input type="email" value={details.email || ''} maxLength={254} autoComplete="email" disabled={busy} onChange={event => set({ email: event.target.value })} /></label>
    {withAddress && <fieldset className="admin-address-fieldset"><legend>Address</legend><AddressFields value={address} onChange={setAddress} disabled={busy} /></fieldset>}
    {problem && (details.first_name || details.phone || details.email) && <p role="alert" className="admin-field-error">{problem}</p>}
    {error && <p role="alert" className="admin-field-error">{error}</p>}
    <div className="admin-payment-buttons">
      {onCancel && <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>}
      <button type="submit" disabled={busy || Boolean(problem)}>{busy ? 'Saving…' : submitLabel}</button>
    </div>
  </form>
}

export function AddressForm({ initial, submitLabel, onSubmit, onCancel }) {
  const [address, setAddress] = useState({ ...EMPTY_ADDRESS, ...initial })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const problem = validateAddress(address)
  async function submit(event) {
    event.preventDefault()
    if (busy || problem) return
    setBusy(true); setError('')
    try { await onSubmit(address) } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  return <form className="admin-client-form" onSubmit={submit}>
    <AddressFields value={address} onChange={setAddress} disabled={busy} />
    {problem && address.address_line_1 && <p role="alert" className="admin-field-error">{problem}</p>}
    {error && <p role="alert" className="admin-field-error">{error}</p>}
    <div className="admin-payment-buttons">
      <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
      <button type="submit" disabled={busy || Boolean(problem)}>{busy ? 'Saving…' : submitLabel}</button>
    </div>
  </form>
}
