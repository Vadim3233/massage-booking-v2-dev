import { useEffect, useRef, useState } from 'react'
import { dayParts } from '../dateStrip.js'
import { timeLabel } from '../bookingDraft.js'
import { preferenceChoices } from '../wantedTimes.js'

const shortDay = (date) => { const parts = dayParts(date); return `${parts.weekday} ${parts.day}` }

// Under the times, after a faded time is tapped (ADR-095): "09:00 on Sat 7 isn't available, but in case anything changes, I can let you know."
// Someone signed in answers with one tap; anybody else adds a phone number or an email. Nothing is booked.
export function AskPanel({ date, start, duration, signedIn, asked, ask, close }) {
  const [contact, setContact] = useState('')
  const [needsContact, setNeedsContact] = useState(!signedIn)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const box = useRef(null)
  useEffect(() => { box.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }) }, [start])
  const when = `${timeLabel(start)} on ${shortDay(date)}`
  if (asked) {
    return <div className="ask-panel is-done" role="status" ref={box}><p><b>Thank you.</b> If anything changes for {shortDay(date)} at {timeLabel(start)}, I'll let you know.</p></div>
  }
  async function submit(event) {
    event.preventDefault()
    if (busy || (needsContact && !contact.trim())) return
    setBusy(true); setError('')
    try { await ask({ date, start, duration, contact: needsContact ? contact : null }) }
    catch (failure) {
      // A signed-in client with no phone or email on record is asked for one, without an error.
      if (failure.needsContact && !needsContact) setNeedsContact(true)
      else setError(failure.message)
    }
    finally { setBusy(false) }
  }
  return <form className="ask-panel" onSubmit={submit} ref={box} aria-label={`Ask about ${when}`}>
    <p><b>{when} isn't available</b>, but in case anything changes, I can let you know.</p>
    {needsContact && <label className="ask-contact">Your phone number (or email)
      <input id="ask-contact" value={contact} maxLength={254} autoComplete="tel" disabled={busy} onChange={(event) => setContact(event.target.value)} />
    </label>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="ask-actions">
      <button type="submit" className="btn--primary" disabled={busy || (needsContact && !contact.trim())}>{busy ? 'Just a moment…' : 'Yes, let me know'}</button>
      <button type="button" className="btn--quiet" disabled={busy} onClick={close}>No thanks</button>
    </div>
    {needsContact && <p className="hint">Only used for this. It doesn't book you in.</p>}
  </form>
}

// "None of these suit me" (give it key={date}, so another day starts closed): one tap says what would have suited, to help Vad plan his hours.
export function NoneSuit({ date, record }) {
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState('')
  if (chosen) return <p className="none-suit is-done" role="status"><b>Thanks, noted.</b> That helps me plan my hours.</p>
  if (!open) return <p className="none-suit"><button type="button" className="btn--quiet" onClick={() => setOpen(true)}>None of these suit me</button></p>
  return <div className="none-suit is-open" role="group" aria-label={`What would suit you on ${shortDay(date)}?`}>
    <p><b>What would suit you on {shortDay(date)}?</b></p>
    <div className="none-suit-choices">{preferenceChoices(date).map(([key, label]) => <button type="button" key={key} className="none-suit-choice"
      onClick={() => { record(date, key); setChosen(key) }}>{label}</button>)}</div>
  </div>
}
