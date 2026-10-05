import { useEffect, useState } from 'react'
import { validDetails } from '../bookingDraft.js'

const TEST_CLIENT = {
  first_name: 'Oliver',
  last_name: 'Green',
  phone: '07123 456789',
  address_line_1: '24 Test Street',
  address_line_2: '',
  city: 'London',
  postcode: 'SW3 1AA',
  entry_instructions: '',
  savedAddressId: '',
}

export default function DetailsStep({ draft, user, api, edit, next, report, guest = false }) {
  const [addresses, setAddresses] = useState([])
  const [loading, setLoading] = useState(!guest)
  const [saving, setSaving] = useState(false)
  const showTestFill = import.meta.env.DEV || new URLSearchParams(window.location.search).get('test') === '1'
  useEffect(() => {
    let live = true
    if (guest) {
      edit({ ownerUserId: user.id })
      return () => { live = false }
    }

    const metadata = user.user_metadata || {}
    api.activate().catch((error) => {
      if (error.code !== '22023' || error.message !== 'First name is required for a new client account') throw error
      return api.activate({ first_name: metadata.first_name || metadata.full_name?.split(' ')[0], last_name: metadata.last_name })
    })
      .then(async (profile) => {
        const rows = await api.addresses()
        if (!live) return
        setAddresses(rows)
        if (!profile.online_booking_enabled) { report('Online booking is disabled for this account. Please contact Vad.'); return }
        const details = { ...draft.details, email: user.email || draft.details.email || '' }
        for (const key of ['first_name', 'last_name', 'phone']) if (!details[key]) details[key] = profile[key] || ''
        edit({ details, ownerUserId: user.id })
      }).catch((error) => { if (live) report(error.message) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
    // Activation runs once per account; typing must not reactivate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, user.id, guest])
  const details = draft.details
  function field(key, value) { edit({ details: { ...details, [key]: value } }) }
  function fillTestClient() {
    edit({ details: {
      ...details,
      ...TEST_CLIENT,
      email: guest ? 'oliver.test@example.com' : (user.email || details.email || ''),
    } })
  }
  async function submit(event) {
    event.preventDefault(); setSaving(true)
    try {
      const profile = guest ? await api.activateGuest(details) : await api.activate(details)
      if (!profile.online_booking_enabled) throw new Error('Online booking is disabled for this account. Please contact Vad.')
      edit({ ownerUserId: user.id })
      await next()
    } catch (error) { report(error.message) }
    finally { setSaving(false) }
  }
  return <><h1>Your details</h1><p>{guest ? 'No account is required. Share the details I need for your visit.' : 'Share the details I need for your visit.'}</p>
    {loading && <p role="status">Loading your saved details…</p>}
    <form onSubmit={submit}><fieldset disabled={loading || saving}>
      {showTestFill && <button type="button" onClick={fillTestClient}>Fill test client</button>}
      <div className="two-columns">
        <label>First name<input autoComplete="given-name" value={details.first_name} required onChange={(event) => field('first_name', event.target.value)} /></label>
        <label>Last name<input autoComplete="family-name" value={details.last_name} required onChange={(event) => field('last_name', event.target.value)} /></label>
      </div>
      <label>Email address<input type="email" autoComplete="email" value={guest ? details.email : (user.email || details.email)} readOnly={!guest} required onChange={(event) => guest && field('email', event.target.value)} /></label>
      <label>Contact number<input type="tel" autoComplete="tel" value={details.phone} required onChange={(event) => field('phone', event.target.value)} /></label>
      {!guest && addresses.length > 0 && <label>Saved address<select value={details.savedAddressId} onChange={(event) => {
        const address = addresses.find((item) => item.id === event.target.value)
        edit({ details: { ...details, ...(address ? Object.fromEntries(['address_line_1', 'address_line_2', 'city', 'postcode', 'entry_instructions'].map((key) => [key, address[key] || ''])) : {}), savedAddressId: event.target.value } })
      }}><option value="">Enter an address</option>{addresses.map((address) => <option key={address.id} value={address.id}>{address.label} · {address.address_line_1}, {address.postcode}</option>)}</select></label>}
      <fieldset disabled={!guest && Boolean(details.savedAddressId)}>
        <label>Street address<input autoComplete="address-line1" value={details.address_line_1} required onChange={(event) => field('address_line_1', event.target.value)} /></label>
        <label>Apartment, suite, unit (optional)<input autoComplete="address-line2" value={details.address_line_2} onChange={(event) => field('address_line_2', event.target.value)} /></label>
        <div className="two-columns"><label>City<input autoComplete="address-level2" value={details.city} required onChange={(event) => field('city', event.target.value)} /></label>
          <label>Postcode<input autoComplete="postal-code" value={details.postcode} required onChange={(event) => field('postcode', event.target.value)} /></label></div>
        <label>Entry instructions (optional)<input value={details.entry_instructions} onChange={(event) => field('entry_instructions', event.target.value)} /></label>
      </fieldset>
      <label>Additional notes (optional)<textarea maxLength={4000} value={draft.note} onChange={(event) => edit({ note: event.target.value })} /></label>
      <small>Please do not include medical or health information here. Contact Vad directly if needed.</small>
      <button className="primary" disabled={!validDetails(details)}>{saving ? 'Saving details…' : 'Continue to payment'}</button>
    </fieldset></form>
  </>
}
