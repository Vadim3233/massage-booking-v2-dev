import { useEffect, useState } from 'react'
import { addressFields, addressTyped, blankAddressFields, contactComplete, detailProblems, usualAddress, validDetails } from '../bookingDraft.js'
import { friendlyError } from '../friendlyError.js'
import { MAX_ADDRESS, needsPostcodeNote, NO_POSTCODE_NOTE } from '../../../lib/address.js'

function buildTestClient() {
  const id = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
  const phoneSuffix = String(parseInt(id.slice(0, 8), 16)).padStart(10, '0').slice(-6)
  return {
    first_name: 'Test',
    last_name: `Client ${id.slice(0, 6)}`,
    email: `vadtest.${id}@example.test`,
    phone: `07700${phoneSuffix}`,
    address: '24 Test Street, London, SW3 1AA',
    entry_instructions: '',
    savedAddressId: '',
  }
}

const UNAVAILABLE = "Online booking isn't available on this account just now. Please get in touch and I'll arrange your appointment."

export default function DetailsStep({ draft, user, api, edit, next, report, newTestGuest, onSwitchToAccount, guest = false }) {
  const [addresses, setAddresses] = useState([])
  const [loading, setLoading] = useState(!guest)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [problems, setProblems] = useState({})
  const [unlocked, setUnlocked] = useState(false)
  const showTestTools = import.meta.env.DEV
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
        // The usual address is chosen straight away, so a returning client only has to press Continue. Not when they have already chosen or typed one.
        const usual = usualAddress(rows)
        if (usual && !details.savedAddressId && !addressTyped(details)) Object.assign(details, addressFields(usual), { savedAddressId: usual.id })
        edit({ details, ownerUserId: user.id })
      }).catch((error) => { if (live) report(friendlyError(error)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
    // Activation runs once per account; typing must not reactivate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, user.id, guest])
  const details = draft.details
  // A returning client's name and phone are saved on their account, and pressing Continue saves what is here back to it. So they are locked until
  // "Edit my details" is pressed, and nothing changes by accident. A guest, and anyone with something still missing, has open boxes.
  const locked = !guest && !loading && !unlocked && contactComplete(details)
  function unlock() {
    setUnlocked(true)
    requestAnimationFrame(() => document.getElementById('details-first-name')?.focus())
  }
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
  // A guest who would rather sign in or register: the booking so far is kept, and this screen gives way to the choices.
  async function switchToAccount() {
    if (switching) return
    setSwitching(true)
    try { await onSwitchToAccount() } catch (error) { report(friendlyError(error)) }
    finally { setSwitching(false) }
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
      // A saved number that cannot be right has to be changeable, so the lock opens.
      if (found.phone) setUnlocked(true)
      report('')
      requestAnimationFrame(() => document.getElementById('details-phone')?.focus())
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
    {guest && onSwitchToAccount && <p className="guest-note"><span>You're booking as a guest.</span>
      <button type="button" className="btn--quiet btn--small" disabled={saving || testing || switching} onClick={switchToAccount}>Sign in or create an account instead</button></p>}
    {loading && <p role="status">Loading your saved details…</p>}
    <p className="fine">Everything that is not marked optional is needed so I can find you.</p>
    <form onSubmit={submit}><fieldset disabled={loading || testing}>
      {showTestTools && guest && newTestGuest && <button type="button" className="btn--tonal btn--small" onClick={startNewTestClient}>{testing ? 'Creating test client…' : 'New test client'}</button>}
      {locked && <div className="details-lock">
        <p className="fine" id="details-lock-note">Your name and phone are saved on your account and locked, so nothing changes by accident. Your email is your sign-in and cannot be changed here.</p>
        <button type="button" className="btn--tonal btn--small" aria-describedby="details-lock-note" onClick={unlock}>Edit my details</button>
      </div>}
      {!guest && !loading && unlocked && <p className="fine details-unlocked">You can change your name and phone now. They are saved to your account when you continue.</p>}
      <div className="two-columns">
        <label>First name<input id="details-first-name" readOnly={locked} autoComplete="given-name" maxLength={60} value={details.first_name} required onChange={(event) => field('first_name', event.target.value)} /></label>
        <label>Last name<input readOnly={locked} autoComplete="family-name" maxLength={60} value={details.last_name} required onChange={(event) => field('last_name', event.target.value)} /></label>
      </div>
      <label>Email address<input type="email" inputMode="email" autoComplete="email" maxLength={120} value={guest ? details.email : (user.email || details.email)} readOnly={!guest} required onChange={(event) => guest && field('email', event.target.value)} /></label>
      <label>Contact number<input id="details-phone" readOnly={locked} type="tel" inputMode="tel" autoComplete="tel" maxLength={30} aria-invalid={Boolean(problems.phone)} aria-describedby={problems.phone ? 'details-phone-problem' : undefined} value={details.phone} required onChange={(event) => field('phone', event.target.value)} /></label>
      {problems.phone && <p className="field-problem" id="details-phone-problem" role="alert">{problems.phone}</p>}
      {!guest && addresses.length > 0 && <label>Saved address<select value={details.savedAddressId} onChange={(event) => {
        const address = addresses.find((item) => item.id === event.target.value)
        // A saved address fills the boxes. Putting it down for "Enter an address" empties them, so nothing of it is left behind in the new address.
        const boxes = address ? addressFields(address) : details.savedAddressId ? blankAddressFields() : {}
        edit({ details: { ...details, ...boxes, savedAddressId: event.target.value } })
      }}><option value="">Enter an address</option>{addresses.map((address) => <option key={address.id} value={address.id}>{address.label ? `${address.label} · ` : ''}{address.address}</option>)}</select></label>}
      <fieldset disabled={!guest && Boolean(details.savedAddressId)}>
        <label>Address<textarea id="details-address" autoComplete="street-address" rows={3} maxLength={MAX_ADDRESS} required aria-describedby="details-address-hint" value={details.address} onChange={(event) => field('address', event.target.value)} /></label>
        <p className="fine" id="details-address-hint">Paste or type the whole address: house or flat number, street, town and postcode.</p>
        {!details.savedAddressId && needsPostcodeNote(details.address) && <p className="fine address-note" role="status">{NO_POSTCODE_NOTE}</p>}
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
