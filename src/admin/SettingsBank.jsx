import { useEffect, useState } from 'react'
import { settingsApi, validateBank } from './settingsApi.js'

const EMPTY = { account_name: '', bank_name: '', sort_code: '', account_number: '', note: '' }

export default function SettingsBank({ api = settingsApi }) {
  const [details, setDetails] = useState(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    api.bank().then(saved => { if (live) { setDetails({ ...EMPTY, ...saved }); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, attempt])
  if (error && !details) return <section className="admin-review"><p role="alert">{error}</p><button onClick={() => setAttempt(value => value + 1)}>Try again</button></section>
  if (!details) return <section className="admin-review"><p role="status">Loading…</p></section>
  const set = patch => { setMessage(''); setDetails({ ...details, ...patch }) }
  const problem = validateBank(details)
  async function save(event) {
    event.preventDefault()
    if (busy || problem) return
    setBusy(true); setError(''); setMessage('')
    try { await api.saveBank(details); setMessage('Saved. Clients will see these details when they pay by bank transfer.') }
    catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  return <section className="admin-review" aria-labelledby="bank-title">
    <header className="admin-review-heading"><div><h1 id="bank-title">Bank transfer details</h1><p>What clients see when they choose to pay by bank transfer.</p></div></header>
    <form className="admin-client-form" onSubmit={save}>
      <label className="admin-field">Name on the account<input value={details.account_name} maxLength={120} disabled={busy} onChange={event => set({ account_name: event.target.value })} /></label>
      <label className="admin-field">Bank (optional)<input value={details.bank_name} maxLength={80} disabled={busy} onChange={event => set({ bank_name: event.target.value })} /></label>
      <div className="admin-hours-fields">
        <label className="admin-field">Sort code<input inputMode="numeric" value={details.sort_code} maxLength={8} disabled={busy} onChange={event => set({ sort_code: event.target.value })} /></label>
        <label className="admin-field">Account number<input inputMode="numeric" value={details.account_number} maxLength={9} disabled={busy} onChange={event => set({ account_number: event.target.value })} /></label>
      </div>
      <label className="admin-field">A note for clients (optional)<input value={details.note} maxLength={300} disabled={busy} onChange={event => set({ note: event.target.value })} /></label>
      <p className="admin-detail-hint">The payment reference is added for each booking automatically.</p>
      {problem && (details.account_name || details.sort_code || details.account_number) && <p role="alert" className="admin-field-error">{problem}</p>}
      {error && <p role="alert" className="admin-field-error">{error}</p>}
      {message && <p role="status">{message}</p>}
      <button type="submit" disabled={busy || Boolean(problem)}>{busy ? 'Saving…' : 'Save bank details'}</button>
    </form>
  </section>
}
