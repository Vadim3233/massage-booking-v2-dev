import { useState } from 'react'
import { dateLabel } from '../bookingDraft.js'
import { TIME_WINDOWS } from '../waitlistWindows.js'

// Shown when a day has no suitable times. Leaves the client's details so Vad can get in touch if a time opens up.
export default function WaitlistPanel({ date, duration, join }) {
  const [window, setWindow] = useState('any')
  const [form, setForm] = useState({ name: '', phone: '', email: '', note: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const set = patch => setForm({ ...form, ...patch })
  const valid = form.name.trim() && (form.phone.trim() || form.email.trim())
  async function submit(event) {
    event.preventDefault()
    if (busy || !valid) return
    const [, , from, to] = TIME_WINDOWS.find(([key]) => key === window)
    setBusy(true); setError('')
    try { await join({ date, from, to, duration, ...form }); setDone(true) }
    catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  if (done) return <section className="panel" role="status"><h2>You are on the waitlist</h2><p>Thank you. If a time opens up on {dateLabel(date)}, I will get in touch.</p></section>
  return <section className="panel">
    <h2>Nothing free that day?</h2>
    <p>Leave your details and I will let you know if a time opens up on {dateLabel(date)}. This does not book you in, and it is free.</p>
    <form onSubmit={submit}>
      <label>Your name<input value={form.name} maxLength={120} autoComplete="name" disabled={busy} onChange={event => set({ name: event.target.value })} /></label>
      <label>Phone<input type="tel" value={form.phone} maxLength={30} autoComplete="tel" disabled={busy} onChange={event => set({ phone: event.target.value })} /></label>
      <label>Email<input type="email" value={form.email} maxLength={254} autoComplete="email" disabled={busy} onChange={event => set({ email: event.target.value })} /></label>
      <label>Which time of day suits you?
        <select value={window} disabled={busy} onChange={event => setWindow(event.target.value)}>{TIME_WINDOWS.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select>
      </label>
      <label>Anything I should know? (optional)<textarea maxLength={500} value={form.note} disabled={busy} onChange={event => set({ note: event.target.value })} /></label>
      <p className="hint">Please give a phone number or an email address, so I can reach you.</p>
      {error && <p role="alert" className="error">{error}</p>}
      <button type="submit" disabled={busy || !valid}>{busy ? 'Adding you…' : 'Add me to the waitlist'}</button>
    </form>
  </section>
}
