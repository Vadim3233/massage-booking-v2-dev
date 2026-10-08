import { useEffect, useState } from 'react'
import { RULE_FIELDS, settingsApi, validateRules } from './settingsApi.js'
import { seriesApi, validReminderDays } from './seriesApi.js'

// Repeating bookings: how long before each session it becomes a booking and the client is asked to pay.
function RepeatSetting({ api }) {
  const [days, setDays] = useState(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    api.reminderDays().then(value => { if (live) setDays(String(value)) }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api])
  if (days === null) return error ? <p role="alert">{error}</p> : null
  const valid = validReminderDays(days)
  async function save(event) {
    event.preventDefault()
    if (busy || !valid) return
    setBusy(true); setError(''); setMessage('')
    try { await api.saveReminderDays(Number(days)); setMessage('Saved.') } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  return <form className="admin-client-form" onSubmit={save} aria-labelledby="repeat-setting-title">
    <h2 id="repeat-setting-title">Repeating bookings</h2>
    <label className="admin-field">Ask for payment this many days before each repeat session
      <input inputMode="numeric" value={days} disabled={busy} onChange={event => { setMessage(''); setDays(event.target.value) }} />
      <span className="admin-detail-hint">Until then a repeat only holds the weekly slot. This many days before a session it becomes a booking and the client is reminded to pay for it. Between 1 and 30.</span>
    </label>
    {!valid && <p role="alert" className="admin-field-error">Enter a number of days from 1 to 30.</p>}
    {error && <p role="alert" className="admin-field-error">{error}</p>}
    {message && <p role="status">{message}</p>}
    <button type="submit" disabled={busy || !valid}>{busy ? 'Saving…' : 'Save'}</button>
  </form>
}

export default function SettingsRules({ api = settingsApi, repeatApi = seriesApi }) {
  const [values, setValues] = useState(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    api.rules().then(rules => { if (live) { setValues(Object.fromEntries(Object.entries(rules).map(([key, value]) => [key, String(value)]))); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, attempt])
  if (error && !values) return <section className="admin-review"><p role="alert">{error}</p><button onClick={() => setAttempt(value => value + 1)}>Try again</button></section>
  if (!values) return <section className="admin-review"><p role="status">Loading…</p></section>
  const problem = validateRules(values)
  async function save(event) {
    event.preventDefault()
    if (busy || problem) return
    setBusy(true); setError(''); setMessage('')
    try { await api.saveRules(values); setMessage('Saved. These apply from now on. Appointments already booked, and any fees already recorded, are not changed.') }
    catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  return <section className="admin-review" aria-labelledby="rules-title">
    <header className="admin-review-heading"><div><h1 id="rules-title">Booking rules</h1><p>How far ahead clients can book, how much notice they need, and when changes are free.</p></div></header>
    <form className="admin-client-form" onSubmit={save}>
      {RULE_FIELDS.map(field => <label key={field.key} className="admin-field">{field.label}
        <input inputMode="numeric" value={values[field.key]} disabled={busy} onChange={event => { setMessage(''); setValues({ ...values, [field.key]: event.target.value }) }} />
        <span className="admin-detail-hint">{field.hint}</span>
      </label>)}
      {problem && <p role="alert" className="admin-field-error">{problem}</p>}
      {error && <p role="alert" className="admin-field-error">{error}</p>}
      {message && <p role="status">{message}</p>}
      <button type="submit" disabled={busy || Boolean(problem)}>{busy ? 'Saving…' : 'Save rules'}</button>
    </form>
    <RepeatSetting api={repeatApi} />
  </section>
}
