import { useEffect, useRef, useState } from 'react'
import { fillShareMessage, SHARE_BLANKS, SHARE_MESSAGE_LIMIT, shareMessageProblem, shareValues, STANDARD_SHARE_MESSAGE } from './shareBooking.js'
import { shareMessageApi } from './shareMessageApi.js'

// A made-up booking, only to show how the wording reads: labelled as an example on the page.
const EXAMPLE_BOOKING = {
  date: '2026-11-12', start_minutes: 1050, treatment_duration_minutes: 90, total_gbp: 105, booking_reference: 'VM-0000', address_snapshot: '1 Example Street, London SW1A 1AA',
  booking_sessions: [{ position: 1, service_name_snapshot: 'Deep tissue', duration_minutes: 90 }],
  booking_payments: { method: 'bank_transfer', status: 'awaiting_transfer', payment_reference: 'VM-0000' },
}
const EXAMPLE_BANK = { configured: true, accountName: 'Your name', bankName: 'Your bank', sortCode: '00-00-00', accountNumber: '00000000', note: '' }

// Settings › Share message: the wording of the booking details sent from a booking's share button, with blanks for what each booking fills in.
export default function SettingsShareMessage({ api = shareMessageApi }) {
  const [text, setText] = useState(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const box = useRef(null)
  useEffect(() => {
    let live = true
    api.get().then(saved => { if (live) { setText(saved || STANDARD_SHARE_MESSAGE); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, attempt])
  if (error && text === null) return <section className="admin-review"><p role="alert">{error}</p><button onClick={() => setAttempt(value => value + 1)}>Try again</button></section>
  if (text === null) return <section className="admin-review"><p role="status">Loading…</p></section>
  const problem = shareMessageProblem(text)
  const change = value => { setMessage(''); setText(value) }
  // A blank goes in where the cursor is, and the cursor moves past it.
  function insert(name) {
    const field = box.current
    const blank = `{${name}}`
    const [start, end] = field ? [field.selectionStart, field.selectionEnd] : [text.length, text.length]
    change(text.slice(0, start) + blank + text.slice(end))
    requestAnimationFrame(() => { if (field) { field.focus(); field.setSelectionRange(start + blank.length, start + blank.length) } })
  }
  async function save(event) {
    event.preventDefault()
    if (busy || problem) return
    setBusy(true); setError(''); setMessage('')
    try { await api.save(text); setMessage('Saved. The share button uses it now.') } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  return <section className="admin-review" aria-labelledby="share-message-title">
    <header className="admin-review-heading"><div><h1 id="share-message-title">Share message</h1><p>What the share button on a booking sends: WhatsApp client, Share… and Copy.</p></div></header>
    <form className="admin-client-form" onSubmit={save}>
      <div className="admin-field"><label htmlFor="share-message-text">Message</label>
        <textarea id="share-message-text" ref={box} rows={8} maxLength={SHARE_MESSAGE_LIMIT + 50} value={text} disabled={busy} aria-describedby="share-message-hint" onChange={event => change(event.target.value)} />
        <span id="share-message-hint" className="admin-detail-hint">{text.trim().length} of {SHARE_MESSAGE_LIMIT}. Words between *stars* show in bold in WhatsApp. A line whose blank has nothing to say is left out: no address, or no bank details when nothing is due.</span>
      </div>
      <div className="admin-share-blanks" role="group" aria-label="Add a blank">
        {SHARE_BLANKS.map(name => <button key={name} type="button" className="btn--tonal btn--small" disabled={busy} onClick={() => insert(name)}>{`{${name}}`}</button>)}
      </div>
      {problem && <p role="alert" className="admin-field-error">{problem}</p>}
      {error && <p role="alert" className="admin-field-error">{error}</p>}
      {message && <p role="status">{message}</p>}
      <div className="admin-payment-buttons">
        <button type="submit" className="btn--primary" disabled={busy || Boolean(problem)}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn--tonal" disabled={busy || text === STANDARD_SHARE_MESSAGE} onClick={() => change(STANDARD_SHARE_MESSAGE)}>Reset to standard</button>
      </div>
    </form>
    <section aria-labelledby="share-preview-title"><h2 id="share-preview-title">Example</h2>
      <p className="admin-detail-hint">A made-up booking still to be paid by bank transfer, with sample bank details. A real one uses the booking and your bank details.</p>
      <pre className="admin-share-preview">{problem ? '' : fillShareMessage(text, shareValues(EXAMPLE_BOOKING, EXAMPLE_BANK))}</pre>
    </section>
  </section>
}
