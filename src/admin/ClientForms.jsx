import { useState } from 'react'
import { addressTyped, validateAddress, validateClient, validateOptionalAddress } from './clientsApi.js'
import { MAX_ADDRESS, needsPostcodeNote, NO_POSTCODE_NOTE_ADMIN } from '../lib/address.js'

const EMPTY_ADDRESS = { label: '', address: '', entry_instructions: '' }

export function AddressFields({ value, onChange, disabled }) {
  const set = patch => onChange({ ...value, ...patch })
  return <>
    <label className="admin-field">Address<textarea value={value.address || ''} rows={3} maxLength={MAX_ADDRESS} autoComplete="street-address" disabled={disabled} aria-describedby="admin-address-hint" onChange={event => set({ address: event.target.value })} /></label>
    <p className="admin-detail-hint" id="admin-address-hint">Paste or type the whole address: house or flat number, street, town and postcode.</p>
    {needsPostcodeNote(value.address) && <p className="admin-detail-hint" role="status">{NO_POSTCODE_NOTE_ADMIN}</p>}
    <label className="admin-field">Entry instructions (optional)<input value={value.entry_instructions || ''} maxLength={300} disabled={disabled} onChange={event => set({ entry_instructions: event.target.value })} /></label>
    <label className="admin-field">Label (optional, for example Home or Office)<input value={value.label || ''} maxLength={60} disabled={disabled} onChange={event => set({ label: event.target.value })} /></label>
  </>
}

// Details for a client, with an address when adding someone new. Only the name is needed; the address is optional. The server checks everything again.
export function ClientForm({ initial, withAddress, submitLabel, onSubmit, onCancel }) {
  // Only the four contact fields are ever sent; the screen may be given a whole client record.
  const [details, setDetails] = useState({ first_name: initial?.first_name || '', last_name: initial?.last_name || '', phone: initial?.phone || '', email: initial?.email || '' })
  const [address, setAddress] = useState(EMPTY_ADDRESS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const problem = validateClient(details) || (withAddress ? validateOptionalAddress(address) : '')
  async function submit(event) {
    event.preventDefault()
    if (busy || problem) return
    setBusy(true); setError('')
    try { await onSubmit(withAddress && addressTyped(address) ? { ...details, address: address.address, entry_instructions: address.entry_instructions } : details) }
    catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  const set = patch => setDetails({ ...details, ...patch })
  return <form className="admin-client-form" onSubmit={submit}>
    {withAddress && <p className="admin-detail-hint">Only the name is needed. The phone, email and address can be added now or later.</p>}
    <div className="admin-hours-fields">
      <label className="admin-field">First name<input value={details.first_name} maxLength={120} autoComplete="given-name" disabled={busy} onChange={event => set({ first_name: event.target.value })} /></label>
      <label className="admin-field">Last name<input value={details.last_name || ''} maxLength={120} autoComplete="family-name" disabled={busy} onChange={event => set({ last_name: event.target.value })} /></label>
    </div>
    <label className="admin-field">Phone<input type="tel" value={details.phone || ''} maxLength={30} autoComplete="tel" disabled={busy} onChange={event => set({ phone: event.target.value })} /></label>
    <label className="admin-field">Email<input type="email" value={details.email || ''} maxLength={254} autoComplete="email" disabled={busy} onChange={event => set({ email: event.target.value })} /></label>
    {withAddress && <fieldset className="admin-address-fieldset"><legend>Address</legend><p className="admin-detail-hint">Leave this empty to add it later.</p><AddressFields value={address} onChange={setAddress} disabled={busy} /></fieldset>}
    {problem && (details.first_name || details.phone || details.email || addressTyped(address)) && <p role="alert" className="admin-field-error">{problem}</p>}
    {error && <p role="alert" className="admin-field-error">{error}</p>}
    <div className="admin-payment-buttons">
      {onCancel && <button type="button" className="btn--quiet" disabled={busy} onClick={onCancel}>Cancel</button>}
      <button type="submit" className="btn--primary" disabled={busy || Boolean(problem)}>{busy ? 'Saving…' : submitLabel}</button>
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
    {problem && address.address && <p role="alert" className="admin-field-error">{problem}</p>}
    {error && <p role="alert" className="admin-field-error">{error}</p>}
    <div className="admin-payment-buttons">
      <button type="button" className="btn--quiet" disabled={busy} onClick={onCancel}>Cancel</button>
      <button type="submit" className="btn--primary" disabled={busy || Boolean(problem)}>{busy ? 'Saving…' : submitLabel}</button>
    </div>
  </form>
}
