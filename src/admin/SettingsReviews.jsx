import { useEffect, useRef, useState } from 'react'
import { REVIEW_BLANKS, REVIEW_MESSAGE_LIMIT, reviewLinkProblem, reviewMessageProblem, reviewText, STANDARD_REVIEW_MESSAGE } from './reviewInvite.js'
import { reviewApi } from './reviewApi.js'

// More › Google reviews: the review link, whether clients are asked automatically, and the wording of the message.
export default function SettingsReviews({ api = reviewApi }) {
  const [values, setValues] = useState(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const box = useRef(null)
  useEffect(() => {
    let live = true
    api.settings().then(saved => { if (live) { setValues({ link: saved.link, message: saved.message || STANDARD_REVIEW_MESSAGE, auto: saved.auto }); setError('') } },
      failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, attempt])
  if (error && values === null) return <section className="admin-review"><p role="alert">{error}</p><button onClick={() => setAttempt(value => value + 1)}>Try again</button></section>
  if (values === null) return <section className="admin-review"><p role="status">Loading…</p></section>
  const linkProblem = reviewLinkProblem(values.link)
  const textProblem = reviewMessageProblem(values.message)
  const autoProblem = values.auto && !values.link.trim() ? 'Add your review link before asking automatically.' : ''
  const problem = linkProblem || textProblem || autoProblem
  const change = patch => { setMessage(''); setValues(current => ({ ...current, ...patch })) }
  function insert(name) {
    const field = box.current
    const blank = `{${name}}`
    const text = values.message
    const [start, end] = field ? [field.selectionStart, field.selectionEnd] : [text.length, text.length]
    change({ message: text.slice(0, start) + blank + text.slice(end) })
    requestAnimationFrame(() => { if (field) { field.focus(); field.setSelectionRange(start + blank.length, start + blank.length) } })
  }
  async function save(event) {
    event.preventDefault()
    if (busy || problem) return
    setBusy(true); setError(''); setMessage('')
    try { await api.save(values); setMessage('Saved.') } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  return <section className="admin-review" aria-labelledby="reviews-title">
    <header className="admin-review-heading"><div><h1 id="reviews-title">Google reviews</h1><p>Your review link, and how clients are asked for a review after a paid session.</p></div></header>
    <form className="admin-client-form" onSubmit={save}>
      <div className="admin-field"><label htmlFor="review-link">Your Google review link</label>
        <input id="review-link" type="url" inputMode="url" autoComplete="off" value={values.link} disabled={busy} aria-describedby="review-link-hint" aria-invalid={Boolean(linkProblem) || undefined} onChange={event => change({ link: event.target.value })} />
        <span id="review-link-hint" className="admin-detail-hint">From Google Business › Get more reviews. {values.link && !linkProblem && <a href={values.link.trim()} target="_blank" rel="noopener noreferrer">Open it to check</a>}</span>
      </div>
      <label className="admin-field admin-field--switch"><span><input type="checkbox" role="switch" checked={values.auto} disabled={busy} onChange={event => change({ auto: event.target.checked })} /> Ask automatically</span>
        <span className="admin-detail-hint">When this is on, a client is sent the message by email (and on Telegram, if they turned it on) at 11:00, two days after a paid session. When it is off, you ask from the booking: a paid booking shows "Ask for a Google review" once the session is over. Either way, each client is asked only once, and anyone you have already asked is never sent it again. Only sessions from the last two weeks count, so turning it on does not reach clients from long ago.</span>
      </label>
      <div className="admin-field"><label htmlFor="review-message">Message</label>
        <textarea id="review-message" ref={box} rows={7} maxLength={REVIEW_MESSAGE_LIMIT + 50} value={values.message} disabled={busy} aria-describedby="review-message-hint" onChange={event => change({ message: event.target.value })} />
        <span id="review-message-hint" className="admin-detail-hint">{values.message.trim().length} of {REVIEW_MESSAGE_LIMIT}. {'{name}'} is the client's first name ("Hi!" when none is saved), {'{link}'} your review link.</span>
      </div>
      <div className="admin-share-blanks" role="group" aria-label="Add a blank">
        {REVIEW_BLANKS.map(name => <button key={name} type="button" className="btn--tonal btn--small" disabled={busy} onClick={() => insert(name)}>{`{${name}}`}</button>)}
      </div>
      {problem && <p role="alert" className="admin-field-error">{problem}</p>}
      {error && <p role="alert" className="admin-field-error">{error}</p>}
      {message && <p role="status">{message}</p>}
      <div className="admin-payment-buttons">
        <button type="submit" className="btn--primary" disabled={busy || Boolean(problem)}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn--tonal" disabled={busy || values.message === STANDARD_REVIEW_MESSAGE} onClick={() => change({ message: STANDARD_REVIEW_MESSAGE })}>Reset to standard</button>
      </div>
    </form>
    <section aria-labelledby="review-preview-title"><h2 id="review-preview-title">Example</h2>
      <p className="admin-detail-hint">What a client called Sarah gets.</p>
      <pre className="admin-share-preview">{textProblem ? '' : reviewText(values.message, 'Sarah', values.link || 'https://g.page/r/your-link/review')}</pre>
    </section>
  </section>
}
