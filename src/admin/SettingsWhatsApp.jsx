import { useEffect, useState } from 'react'
import { checkWhatsApp, whatsappApi } from './whatsappApi.js'
import { whatsappLink, WHATSAPP_HELLO } from '../client/whatsapp.js'

// More › WhatsApp button (ADR-109): the green "WhatsApp me" button on the booking page, the FAQ and each client's appointment page.
export default function SettingsWhatsApp({ api = whatsappApi }) {
  const [values, setValues] = useState(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    api.get().then(row => { if (live) { setValues({ number: row.number ? `+${row.number}` : '', show: row.show }); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, attempt])
  if (error && !values) return <section className="admin-review"><p role="alert">{error}</p><button onClick={() => setAttempt(value => value + 1)}>Try again</button></section>
  if (!values) return <section className="admin-review"><p role="status">Loading…</p></section>
  const { digits, problem } = checkWhatsApp(values)
  const change = patch => { setMessage(''); setValues({ ...values, ...patch }) }
  async function save(event) {
    event.preventDefault()
    if (busy || problem) return
    setBusy(true); setError(''); setMessage('')
    try {
      await api.save({ number: digits, show: values.show })
      setMessage(values.show ? 'Saved. Clients see the green WhatsApp me button now.' : 'Saved. The button is hidden.')
    } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  return <section className="admin-review" aria-labelledby="whatsapp-settings-title">
    <header className="admin-review-heading"><div><h1 id="whatsapp-settings-title">WhatsApp button</h1><p>A green "WhatsApp me" button at the bottom of the booking page, the FAQ and each client's appointment page, so clients can reach you if something comes up.</p></div></header>
    <form className="admin-client-form" onSubmit={save}>
      <label className="admin-field">Your WhatsApp number
        <input type="tel" inputMode="tel" autoComplete="tel" value={values.number} disabled={busy} placeholder="07…" onChange={event => change({ number: event.target.value })} />
        <span className="admin-detail-hint">Type it as you would, for example 07700 900123. Clients only see it when they open WhatsApp.</span>
      </label>
      <label className="admin-field admin-field--switch"><span><input type="checkbox" role="switch" checked={values.show} disabled={busy} onChange={event => change({ show: event.target.checked })} /> Show the button to clients</span></label>
      {digits && !problem && <p className="admin-detail-hint"><a href={whatsappLink(digits, WHATSAPP_HELLO.booking)} target="_blank" rel="noopener noreferrer">Try it</a>: opens WhatsApp with the message a client starts with ("{WHATSAPP_HELLO.booking}"). On an appointment page the message names the day, time and booking reference instead.</p>}
      {problem && <p role="alert" className="admin-field-error">{problem}</p>}
      {error && <p role="alert" className="admin-field-error">{error}</p>}
      {message && <p role="status">{message}</p>}
      <button type="submit" className="btn--primary btn--block" disabled={busy || Boolean(problem)}>{busy ? 'Saving…' : 'Save'}</button>
    </form>
  </section>
}
