import { useEffect, useState } from 'react'
import { EMPTY_DETAILS, receiptsApi, validateReceiptDetails } from './receiptsApi.js'

// What is printed at the top of every new receipt. Nothing is made until these are saved.
export default function SettingsReceipts({ api = receiptsApi }) {
  const [details, setDetails] = useState(null)
  const [wasSaved, setWasSaved] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    api.details().then(saved => { if (live) { setDetails({ ...EMPTY_DETAILS, ...saved }); setWasSaved(Boolean(saved)); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, attempt])
  if (error && !details) return <section className="admin-review"><p role="alert">{error}</p><button onClick={() => setAttempt(value => value + 1)}>Try again</button></section>
  if (!details) return <section className="admin-review"><p role="status">Loading…</p></section>
  const set = patch => { setMessage(''); setDetails({ ...details, ...patch }) }
  const problem = validateReceiptDetails(details)
  async function save(event) {
    event.preventDefault()
    if (busy || problem) return
    setBusy(true); setError(''); setMessage('')
    try { await api.saveDetails(details); setWasSaved(true); setMessage('Saved. New receipts will use these details. A receipt you have already made keeps its own, which you can change with Edit on the receipt.') }
    catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  return <section className="admin-review" aria-labelledby="receipt-details-title">
    <header className="admin-review-heading"><div><h1 id="receipt-details-title">Receipt details</h1><p>What is printed at the top of a receipt you send to a client.</p></div></header>
    <form className="admin-client-form" onSubmit={save}>
      <label className="admin-field">Business name<input value={details.name} maxLength={120} disabled={busy} onChange={event => set({ name: event.target.value })} /></label>
      <label className="admin-field">A line under the name (optional)<input value={details.tagline} maxLength={160} disabled={busy} onChange={event => set({ tagline: event.target.value })} /></label>
      <div className="admin-hours-fields">
        <label className="admin-field">Phone<input type="tel" value={details.phone} maxLength={40} autoComplete="tel" disabled={busy} onChange={event => set({ phone: event.target.value })} /></label>
        <label className="admin-field">Email<input type="email" value={details.email} maxLength={254} autoComplete="email" disabled={busy} onChange={event => set({ email: event.target.value })} /></label>
      </div>
      <label className="admin-field">Website<input value={details.website} maxLength={120} autoComplete="url" disabled={busy} onChange={event => set({ website: event.target.value })} /></label>
      <label className="admin-field">Address (optional)<textarea rows={3} maxLength={300} value={details.address} disabled={busy} onChange={event => set({ address: event.target.value })} /></label>
      <label className="admin-field">A closing line (optional, for example Thank you)<input value={details.closing} maxLength={200} disabled={busy} onChange={event => set({ closing: event.target.value })} /></label>
      <fieldset className="admin-address-fieldset"><legend>Practitioner credentials</legend>
        <p className="admin-detail-hint">On every receipt, as health insurers ask for them. Not shown as a statutory registration.</p>
        <label className="admin-field">Your full name<input value={details.practitioner_name} maxLength={120} autoComplete="name" disabled={busy} onChange={event => set({ practitioner_name: event.target.value })} /></label>
        <label className="admin-field">Professional title (optional)<input value={details.practitioner_title} maxLength={120} disabled={busy} onChange={event => set({ practitioner_title: event.target.value })} /></label>
        <label className="admin-field">Professional association<input value={details.association} maxLength={160} disabled={busy} onChange={event => set({ association: event.target.value })} /></label>
        <label className="admin-field">Membership number<input value={details.membership_number} maxLength={40} disabled={busy} onChange={event => set({ membership_number: event.target.value })} /></label>
      </fieldset>
      <p className="admin-detail-hint">A receipt shows the treatment, what was paid and how, and your credentials, and says nothing about VAT.</p>
      {!wasSaved && <p className="admin-detail-hint">Nothing is saved here yet. Until you save your details, a receipt cannot be made.</p>}
      {problem && (details.name || details.phone || details.email) && <p role="alert" className="admin-field-error">{problem}</p>}
      {error && <p role="alert" className="admin-field-error">{error}</p>}
      {message && <p role="status">{message}</p>}
      <button type="submit" className="btn--primary btn--lg btn--block" disabled={busy || Boolean(problem)}>{busy ? 'Saving…' : 'Save receipt details'}</button>
    </form>
  </section>
}
