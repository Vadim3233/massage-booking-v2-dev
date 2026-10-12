import { useEffect, useState } from 'react'
import { detailProblems, validDetails } from '../bookingDraft.js'
import { friendlyError } from '../friendlyError.js'

function buildTestClient() {
  const id = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
  const phoneSuffix = String(parseInt(id.slice(0, 8), 16)).padStart(10, '0').slice(-6)
  return {
    first_name: 'Test',
    last_name: `Client ${id.slice(0, 6)}`,
    email: `vadtest.${id}@example.test`,
    phone: `07700${phoneSuffix}`,
    address_line_1: '24 Test Street',
    address_line_2: '',
    city: 'London',
    postcode: 'SW3 1AA',
    entry_instructions: '',
    savedAddressId: '',
  }
}

const UNAVAILABLE = "Online booking isn't available on this account just now. Please get in touch and I'll arrange your appointment."

export default function DetailsStep({ draft, user, api, edit, next, report, newTestGuest, guest = false }) {
  const [addresses, setAddresses] = useState([])
  const [loading, setLoading] = useState(!guest)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [problems, setProblems] = useState({})
  const showTestTools = import.meta.env.DEV || new URLSearchParams(window.location.search).get('test') === '1'
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
        if (!profile.online_booking_enabled) { report(UNAVAILABLE); return }
        const details = { ...draft.details, email: user.email || draft.details.email || '' }
        for (const key of ['first_name', 'last_name', 'phone']) if (!details[key]) details[key] = profile[key] || ''
        edit({ details, ownerUserId: user.id })
      }).catch((error) => { if (live) report(friendlyError(error)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
    // Activation runs once per account; typing must not reactivate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, user.id, guest])
  const details = draft.details
  function field(key, value) {
    if (problems[key]) setProblems((known) => ({ ...known, [key]: undefined }))
    edit({ details: { ...details, [key]: value } })
  }
  async function startNewTestClient() {
    if (!guest || !newTestGuest || testing) return
    setTesting(true)
    try {
      await newTestGuest(buildTestClient())
    } catch (error) {
      setTesting(false)
      report(friendlyError(error))
    }
  }
  async function submit(event) {
    event.preventDefault()
    if (saving) return
    // The button is never greyed out; what is missing is said in words instead.
    if (!validDetails(details)) { report('Please fill in everything that is not marked optional.'); return }
    // What is plainly wrong is said beside the field, and she is taken to it.
    const found = detailProblems(details)
    if (Object.keys(found).length) {
      setProblems(found)
      report('')
      const first = ['phone', 'postcode'].find((key) => found[key])
      requestAnimationFrame(() => document.getElementById(`details-${first}`)?.focus())
      return
    }
    setSaving(true)
    try {
      const profile = guest ? await api.activateGuest(details) : await api.activate(details)
      if (!profile.online_booking_enabled) throw new Error(UNAVAILABLE)
      edit({ ownerUserId: user.id })
      await next()
    } catch (error) { report(friendlyError(error)) }
    finally { setSaving(false) }
  }
  return <><h1 tabIndex={-1}>Your <em>details</em></h1><p className="lede">{guest ? 'No account is required. Share the details I need for your visit.' : 'Share the details I need for your visit.'} I only use them to arrange your appointment and to get in touch about it.</p>
    {loading && <p role="status">Loading your saved details…</p>}
    <p className="fine">Everything that is not marked optional is needed so I can find you.</p>
    <form onSubmit={submit}><fieldset disabled={loading || testing}>
      {showTestTools && guest && newTestGuest && <button type="button" className="btn--tonal btn--small" onClick={startNewTestClient}>{testing ? 'Creating test client…' : 'New test client'}</button>}
      <div className="two-columns">
        <label>First name<input autoComplete="given-name" maxLength={60} value={details.first_name} required onChange={(event) => field('first_name', event.target.value)} /></label>
        <label>Last name<input autoComplete="family-name" maxLength={60} value={details.last_name} required onChange={(event) => field('last_name', event.target.value)} /></label>
      </div>
      <label>Email address<input type="email" inputMode="email" autoComplete="email" maxLength={120} value={guest ? details.email : (user.email || details.email)} readOnly={!guest} required onChange={(event) => guest && field('email', event.target.value)} /></label>
      <label>Contact number<input id="details-phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={30} aria-invalid={Boolean(problems.phone)} aria-describedby={problems.phone ? 'details-phone-problem' : undefined} value={details.phone} required onChange={(event) => field('phone', event.target.value)} /></label>
      {problems.phone && <p className="field-problem" id="details-phone-problem" role="alert">{problems.phone}</p>}
      {!guest && addresses.length > 0 && <label>Saved address<select value={details.savedAddressId} onChange={(event) => {
        const address = addresses.find((item) => item.id === event.target.value)
        setProblems((known) => ({ ...known, postcode: undefined }))
        edit({ details: { ...details, ...(address ? Object.fromEntries(['address_line_1', 'address_line_2', 'city', 'postcode', 'entry_instructions'].map((key) => [key, address[key] || ''])) : {}), savedAddressId: event.target.value } })
      }}><option value="">Enter an address</option>{addresses.map((address) => <option key={address.id} value={address.id}>{address.label} · {address.address_line_1}, {address.postcode}</option>)}</select></label>}
      <fieldset disabled={!guest && Boolean(details.savedAddressId)}>
        <label>Street address<input autoComplete="address-line1" maxLength={120} value={details.address_line_1} required onChange={(event) => field('address_line_1', event.target.value)} /></label>
        <label>Flat or building (optional)<input autoComplete="address-line2" maxLength={120} value={details.address_line_2} onChange={(event) => field('address_line_2', event.target.value)} /></label>
        <div className="two-columns"><label>City<input autoComplete="address-level2" maxLength={60} value={details.city} required onChange={(event) => field('city', event.target.value)} /></label>
          <label>Postcode<input id="details-postcode" autoComplete="postal-code" autoCapitalize="characters" maxLength={12} aria-invalid={Boolean(problems.postcode) && !details.savedAddressId} aria-describedby={problems.postcode && !details.savedAddressId ? 'details-postcode-problem' : undefined} value={details.postcode} required onChange={(event) => field('postcode', event.target.value)} /></label></div>
        {problems.postcode && !details.savedAddressId && <p className="field-problem" id="details-postcode-problem" role="alert">{problems.postcode}</p>}
      </fieldset>
      <details className="more more--flat">
        <summary><span className="more-title">How to get in</span><span className="more-hint">Optional</span></summary>
        <div className="more-body">
          <fieldset disabled={!guest && Boolean(details.savedAddressId)}><label>Entry instructions (optional)<input maxLength={200} value={details.entry_instructions} onChange={(event) => field('entry_instructions', event.target.value)} /></label></fieldset>
        </div>
      </details>
      <div className="action-bar"><button className="btn--primary btn--lg btn--block">{saving ? 'Saving details…' : 'Continue to payment'}</button></div>
    </fieldset></form>
  </>
}
