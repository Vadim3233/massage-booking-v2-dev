import { useEffect, useState } from 'react'
import { MAX_ADDRESS } from '../lib/address.js'
import { toast } from '../ui/toast.js'
import { catalogueApi } from './catalogueApi.js'
import { ADDRESS_EDITABLE, addressPreview, bookingAddressApi } from './bookingAddressApi.js'
import { money } from './calendarPresentation.js'

// The booking's address, with Edit address while the appointment is still to come. The area follows the postcode when the areas have
// postcodes; a different area shows its new total before anything is saved, and the client is told by email and Telegram.
export default function AddressEdit({ booking, refresh, api = bookingAddressApi, areasApi = catalogueApi }) {
  const [form, setForm] = useState(null)
  const [areas, setAreas] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!form || areas) return
    let live = true
    areasApi.areas().then(rows => { if (live) setAreas(rows) }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [form, areas, areasApi])
  const shown = <><address>{booking.address_snapshot}</address>{booking.entry_instructions_snapshot && <p>{booking.entry_instructions_snapshot}</p>}</>
  if (!ADDRESS_EDITABLE.includes(booking.booking_status)) return shown
  if (!form) return <>{shown}<button className="btn--quiet btn--small" onClick={() => { setError(''); setForm({ address: booking.address_snapshot || '', entry: booking.entry_instructions_snapshot || '', areaId: booking.service_area_id }) }}>Edit address</button></>
  const choices = (areas || []).filter(area => area.active || area.id === booking.service_area_id)
  const preview = addressPreview(booking, choices, form)
  function typeAddress(address) {
    // The area follows the postcode as it is typed, while one is found.
    const found = addressPreview(booking, choices, { ...form, address }).suggested
    setForm({ ...form, address, areaId: found ? found.id : form.areaId })
  }
  async function save(event) {
    event.preventDefault()
    if (busy || preview.problem || !areas) return
    setBusy(true)
    setError('')
    try {
      await api.change(booking, crypto.randomUUID(), form)
      toast('Address changed. The client has been told.')
      setForm(null)
      await refresh()
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  return <form className="admin-client-form" onSubmit={save}>
    <label className="admin-field">Address<textarea rows={3} maxLength={MAX_ADDRESS} value={form.address} disabled={busy} onChange={event => typeAddress(event.target.value)} /></label>
    <label className="admin-field">Entry instructions (optional)<input maxLength={200} value={form.entry} disabled={busy} onChange={event => setForm({ ...form, entry: event.target.value })} /></label>
    <label className="admin-field">Area<select value={form.areaId} disabled={busy || !areas} onChange={event => setForm({ ...form, areaId: event.target.value })}>
      {choices.map(area => <option key={area.id} value={area.id}>{area.name}</option>)}
    </select></label>
    {!areas && !error && <p role="status">Loading areas…</p>}
    {preview.priceChanges && <p role="status">New price {money(preview.total)} (was {money(booking.total_gbp)}), with {preview.area?.name}'s travel fees.</p>}
    {preview.problem && <p role="alert" className="admin-field-error">{preview.problem}</p>}
    {error && <p role="alert" className="admin-field-error">{error}</p>}
    <div className="admin-payment-buttons">
      <button type="button" className="btn--quiet" disabled={busy} onClick={() => setForm(null)}>Cancel</button>
      <button type="submit" className="btn--primary" disabled={busy || Boolean(preview.problem) || !areas}>{busy ? 'Saving…' : 'Save address'}</button>
    </div>
  </form>
}
