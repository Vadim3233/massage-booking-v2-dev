import { useEffect, useState } from 'react'
import { clientsApi, fullName } from './clientsApi.js'
import { cautions, combineNotices, holdings, kindLabel, matchedText, movesText, profileLabel } from './samePerson.js'
import { toast } from '../ui/toast.js'

const since = value => new Date(value).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' })

// One profile, with what it holds. Two of these sit side by side so the Admin can see whether they are one person.
function Profile({ profile, stays, decided, choose }) {
  const held = holdings(profile)
  return <article className={`admin-combine-card ${decided && stays ? 'is-keep' : ''}`} aria-label={`${fullName(profile)}, ${kindLabel(profile.kind).toLowerCase()}`}>
    <p className="admin-combine-tag">{kindLabel(profile.kind)}</p>
    <h2>{fullName(profile)}</h2>
    <p className="admin-combine-contact">{profile.email || 'No email'}</p>
    <p className="admin-combine-contact">{profile.phone || 'No phone number'}</p>
    <p className="admin-combine-holds"><strong>{held.bookings}</strong>{held.days && <span>{held.days}</span>}{held.more && <span>{held.more}</span>}</p>
    <p className="admin-detail-hint">Client since {since(profile.created_at)}</p>
    {decided && <span className={`chip ${stays ? 'chip--ok' : 'chip--cancel'}`}>{stays ? 'Stays' : 'Joins the other'}</span>}
    {choose && <label className="admin-who-row"><input type="radio" name="keep" checked={stays} onChange={choose} aria-label={`Keep this one: ${profileLabel(fullName(profile), profile.kind)}`} />Keep this one</label>}
  </article>
}

// "Is this the same person?" The two profiles side by side, and the Admin's answer: combine them, say they are different
// people (and not be asked again), or decide later. Combining asks once more, because there is no undo.
export default function CombineClients({ a, b, back, openClient, resolved, api = clientsApi }) {
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState('')
  const [keepId, setKeepId] = useState('')
  const [request, setRequest] = useState('')
  const [returned, setReturned] = useState(false)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    api.combinePreview(a, b).then(value => { if (live) { setPreview(value); setKeepId(value.keep_id); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, a, b, attempt])

  if (!preview) {
    // A profile that is gone will not come back by trying again; a failed connection might.
    const gone = error.startsWith('One of these clients is no longer there')
    return <section className="admin-review admin-combine" aria-labelledby="combine-title">
      <button className="admin-back-link" onClick={back}>← Clients</button>
      <h1 id="combine-title">Same person?</h1>
      {error ? <><p role="alert" className="admin-field-error">{error}</p>
        <div className="admin-payment-buttons">{!gone && <button onClick={() => { setError(''); setAttempt(value => value + 1) }}>Try again</button>}<button className="btn--quiet" onClick={back}>Back to Clients</button></div></>
        : <p role="status">Loading the two profiles…</p>}
    </section>
  }

  const keep = preview.profiles.find(profile => profile.id === keepId) || preview.profiles[0]
  const leave = preview.profiles.find(profile => profile.id !== keep.id)
  // With a login on one side that one stays; a client you added stays over a guest (ADR-092); otherwise the Admin picks.
  const kinds = preview.profiles.map(profile => profile.kind)
  const choosable = preview.can_combine && !kinds.includes('registered') && !(kinds.includes('added') && kinds.includes('guest'))
  const shared = preview.matched_on?.length ? `They share the same ${matchedText(preview.matched_on)}.` : 'They do not share an email or a phone number.'
  const keepLabel = profileLabel(fullName(keep), keep.kind)
  const leaveLabel = profileLabel(fullName(leave), leave.kind)
  // Where a mistake is easier to make there is a warning, and "Yes" is no longer the louder button.
  const warnings = preview.can_combine ? cautions(preview.profiles, preview.matched_on) : []
  // Who can see what afterwards: a guest reaches their bookings only from the phone or browser that made them.
  const notices = combineNotices(keep, leave)

  async function combine() {
    if (busy) return
    setBusy(true); setError('')
    try {
      const summary = await api.combine(keep.id, leave.id, request)
      toast(`Combined into ${fullName(keep)}'s profile. ${movesText(summary)}`)
      resolved?.()
      openClient(keep.id)
    } catch (failure) { setError(failure.message); setBusy(false) }
  }
  async function separate() {
    if (busy) return
    setBusy(true); setError('')
    try {
      await api.keepSeparate(a, b)
      toast('Got it. I will not ask about these two again.')
      resolved?.()
      back()
    } catch (failure) { setError(failure.message); setBusy(false) }
  }

  return <section className="admin-review admin-combine" aria-labelledby="combine-title">
    <button className="admin-back-link" onClick={back}>← Clients</button>
    <h1 id="combine-title">Same person?</h1>
    <p className="admin-combine-lede">{shared} Look them over side by side.</p>
    <div className="admin-combine-cards" {...(choosable ? { role: 'radiogroup', 'aria-label': 'Which profile stays' } : {})}>{preview.profiles.map(profile => <Profile key={profile.id} profile={profile} stays={profile.id === keep.id} decided={preview.can_combine}
      choose={choosable ? () => { setKeepId(profile.id); setRequest('') } : null} />)}</div>
    {!preview.can_combine
      ? <p className="admin-combine-note">These two each have their own login, so they cannot be combined. If they are two different people, say so and I will not ask again.</p>
      : <p className="admin-combine-note">If you combine them, the bookings, notes and addresses of {leaveLabel} move to {keepLabel}, and the other entry goes. There is no undo.</p>}
    {warnings.map(text => <p key={text} className="admin-combine-caution">{text}</p>)}
    {preview.kept_separate && <p className="admin-detail-hint">You have already said these two are different people.</p>}
    {request && preview.can_combine
      ? <div role="alert" className="admin-conflicts admin-combine-confirm">
        <p>Combine {leaveLabel} into {keepLabel} for good? This cannot be undone from the app.{notices.length > 0 && ` ${notices.join(' ')}`}</p>
        <div className="admin-payment-buttons"><button autoFocus disabled={busy} onClick={() => { setRequest(''); setReturned(true) }}>Not yet</button><button className="btn--primary" disabled={busy} onClick={combine}>{busy ? 'Combining…' : 'Yes, combine'}</button></div>
      </div>
      : <div className="admin-combine-actions">
        {preview.can_combine && <button className={warnings.length ? 'btn--block' : 'btn--primary btn--lg btn--block'} autoFocus={returned} disabled={busy} onClick={() => { setError(''); setRequest(crypto.randomUUID()) }}>Yes, combine them</button>}
        {!preview.kept_separate && <button className="btn--block" disabled={busy} onClick={separate}>No, different people</button>}
        <button className="btn--quiet btn--block" disabled={busy} onClick={back}>Decide later</button>
      </div>}
    {error && <p role="alert" className="admin-field-error">{error}</p>}
  </section>
}
