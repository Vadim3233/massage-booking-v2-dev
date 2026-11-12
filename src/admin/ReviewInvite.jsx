import { useEffect, useState } from 'react'
import Icon from '../ui/icons.jsx'
import { askedWords, canAskForReview, reviewText, reviewWhatsappLink } from './reviewInvite.js'
import { reviewApi } from './reviewApi.js'

// "Ask for a Google review", on a booking once the session is over and paid. Each client is asked once: after WhatsApp, Copy message or Mark as
// asked, the card says "Review asked · 12 Nov" on every booking of theirs. Ask again opens the buttons once more; Not asked after all forgets it.
// Nothing is ever sent by itself from here: WhatsApp opens the chat with the message, which can still be changed before sending.
// Until the database update is applied, or with no review link saved, it says so quietly (or shows nothing).
export default function ReviewInvite({ booking, api = reviewApi, now = new Date(), openSettings }) {
  const clientId = booking.client_id || booking.clients?.id
  const show = Boolean(clientId) && canAskForReview(booking, now)
  const [state, setState] = useState(null)
  const [again, setAgain] = useState(false)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState('')
  useEffect(() => {
    if (!show) return undefined
    let live = true
    Promise.all([api.settings(), api.asked(clientId)])
      .then(([settings, asked]) => { if (live) setState({ settings, asked }) },
        error => { if (live) setState({ off: Boolean(error?.notSwitchedOn), error: error?.notSwitchedOn ? '' : 'Could not load the review details.' }) })
    return () => { live = false }
  }, [api, clientId, show])
  if (!show || !state || state.off) return null
  if (state.error) return <section className="admin-next admin-review-invite"><h3>Google review</h3><p role="alert">{state.error}</p></section>
  const { settings, asked } = state
  const first = booking.clients?.first_name?.trim()
  const who = first || 'This client'
  if (!settings.link) return <section className="admin-next admin-review-invite"><h3>Google review</h3>
    <p className="admin-detail-hint">Add your Google review link to ask clients for a review.</p>
    {openSettings && <button type="button" className="btn--tonal btn--small" onClick={openSettings}>Open Google reviews</button>}
  </section>
  const text = reviewText(settings.message, first, settings.link)
  const whatsapp = reviewWhatsappLink(booking.clients?.phone, text)
  async function mark(channel) {
    setBusy(true); setSaid('')
    try { const done = await api.markAsked(booking.id, channel); setState(current => ({ ...current, asked: done })); setAgain(false) }
    catch (error) { setSaid(error.message) }
    finally { setBusy(false) }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(text) } catch { setSaid('Could not copy. Try again.'); return }
    await mark('copy')
    setSaid('Copied. Paste it to the client.')
  }
  async function forget() {
    setBusy(true); setSaid('')
    try { await api.clearAsked(clientId); setState(current => ({ ...current, asked: null })); setAgain(false) }
    catch (error) { setSaid(error.message) }
    finally { setBusy(false) }
  }
  const buttons = <div className="admin-payment-buttons">
    {whatsapp && <a className="btn btn--primary" href={whatsapp} target="_blank" rel="noopener noreferrer" aria-disabled={busy || undefined} onClick={() => { mark('whatsapp') }}><Icon name="chat" />WhatsApp {first || 'client'}</a>}
    <button type="button" className="btn--tonal" disabled={busy} onClick={copy}><Icon name="copy" />Copy message</button>
    {!asked && <button type="button" className="btn--quiet btn--small" disabled={busy} onClick={() => mark('marked')}>Mark as asked</button>}
  </div>
  return <section className="admin-next admin-review-invite" aria-labelledby={`review-${booking.id}`}>
    <h3 id={`review-${booking.id}`}>{asked ? 'Google review' : 'Ask for a Google review'}</h3>
    {asked
      ? <>
        <p className="admin-review-asked"><Icon name="tick" />{askedWords(asked)}</p>
        {again ? buttons : <div className="admin-payment-buttons">
          <button type="button" className="btn--quiet btn--small" disabled={busy} onClick={() => setAgain(true)}>Ask again</button>
          <button type="button" className="btn--quiet btn--small" disabled={busy} onClick={forget}>Not asked after all</button>
        </div>}
      </>
      : <>
        <p className="admin-detail-hint">{who} hasn't been asked yet.</p>
        <pre className="admin-share-preview">{text}</pre>
        {buttons}
        {!whatsapp && <p className="admin-detail-hint">There is no phone number for WhatsApp, so copy the message instead.</p>}
      </>}
    {said && <p role="status">{said}</p>}
  </section>
}
