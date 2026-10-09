import { useEffect, useState } from 'react'
import { ABOUT_LIMIT, validateWelcome, WELCOME_LIMIT, welcomeApi } from './welcomeApi.js'

export default function SettingsWelcome({ api = welcomeApi }) {
  const [values, setValues] = useState(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    api.get().then(row => { if (live) { setValues({ welcome: row?.welcome || '', about: row?.about || '' }); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, attempt])
  if (error && !values) return <section className="admin-review"><p role="alert">{error}</p><button onClick={() => setAttempt(value => value + 1)}>Try again</button></section>
  if (!values) return <section className="admin-review"><p role="status">Loading…</p></section>
  const problem = validateWelcome(values)
  const change = patch => { setMessage(''); setValues({ ...values, ...patch }) }
  async function save(event) {
    event.preventDefault()
    if (busy || problem) return
    setBusy(true); setError(''); setMessage('')
    try { await api.save(values); setMessage('Saved. It shows at the top of the booking page now.') } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  return <section className="admin-review" aria-labelledby="welcome-settings-title">
    <header className="admin-review-heading"><div><h1 id="welcome-settings-title">Welcome message</h1><p>What a new client reads first on the booking page.</p></div></header>
    <form className="admin-client-form" onSubmit={save}>
      <label className="admin-field">Welcome
        <textarea rows={5} maxLength={WELCOME_LIMIT + 50} value={values.welcome} disabled={busy} onChange={event => change({ welcome: event.target.value })} />
        <span className="admin-detail-hint">{values.welcome.trim().length} of {WELCOME_LIMIT}. Leave it empty to show the standard welcome. A blank line starts a new paragraph.</span>
      </label>
      <label className="admin-field">A little about me (optional)
        <textarea rows={8} maxLength={ABOUT_LIMIT + 50} value={values.about} disabled={busy} onChange={event => change({ about: event.target.value })} />
        <span className="admin-detail-hint">{values.about.trim().length} of {ABOUT_LIMIT}. Shown under "A little about me". People looking for a therapist they can trust like to know your training, how long you have practised, and anything such as insurance or membership. Write only what is true; leave it empty to hide it.</span>
      </label>
      {problem && <p role="alert" className="admin-field-error">{problem}</p>}
      {error && <p role="alert" className="admin-field-error">{error}</p>}
      {message && <p role="status">{message}</p>}
      <button type="submit" disabled={busy || Boolean(problem)}>{busy ? 'Saving…' : 'Save'}</button>
    </form>
  </section>
}
