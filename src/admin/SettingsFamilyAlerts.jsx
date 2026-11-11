import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../ui/icons.jsx'
import { cleanUsername, telegramLink } from '../client/booking/telegramLink.js'
import { INVITE_POLL_FOR_MS, INVITE_POLL_MS } from './telegramInvite.js'
import { familyAlertsApi, familyInviteMessage, familyInviteWhatsappLink } from './familyAlertsApi.js'
import { toast } from '../ui/toast.js'

const since = stamp => new Date(stamp).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' })

// More › Family alerts: a short, fun Telegram message (in Spanish) to the family when a booking is confirmed, moved or cancelled, with the
// day, the times and when he is likely home. Never the client's name, address, phone or price. It uses the clients' Telegram bot.
export default function SettingsFamilyAlerts({ api = familyAlertsApi, username = import.meta.env.VITE_TELEGRAM_CLIENT_BOT_USERNAME }) {
  const bot = cleanUsername(username)
  const [chats, setChats] = useState(null)
  const [error, setError] = useState('')
  const [invite, setInvite] = useState(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const pollUntil = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  // Asking again is a new "check": the list is read whenever it goes up (on opening, after a change, and while waiting for her).
  const [check, setCheck] = useState(0)
  const look = useCallback(() => setCheck(value => value + 1), [])
  useEffect(() => {
    let live = true
    api.status().then(list => { if (live) { setChats(list); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, check])
  // Once a new chat shows, the link has done its job: the page says so instead of waiting.
  const joined = Boolean(invite && chats && chats.length > invite.before)
  // While waiting for her to press Start, the page looks every few seconds, for a few minutes.
  useEffect(() => {
    if (!invite || joined) return undefined
    const timer = setInterval(() => { if (Date.now() <= pollUntil.current && document.visibilityState === 'visible') look() }, INVITE_POLL_MS)
    return () => clearInterval(timer)
  }, [invite, joined, look])

  async function makeLink() {
    setBusy(true); setError('')
    try {
      const link = telegramLink(bot, await api.createLink())
      if (!link) throw new Error('Could not make the link. Please try again.')
      pollUntil.current = Date.now() + INVITE_POLL_FOR_MS
      if (alive.current) setInvite({ link, text: familyInviteMessage(link), before: chats?.length || 0 })
    } catch (failure) { if (alive.current) setError(failure.message) } finally { if (alive.current) setBusy(false) }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(invite.link); toast('Telegram link copied') } catch { setError('Could not copy. Select the link and copy it.') }
  }
  async function stop(id) {
    if (!window.confirm('Switch off family alerts for this chat? You can send a new link at any time.')) return
    setBusy(true)
    try { await api.stop(id); toast('Family alerts switched off'); setInvite(null); look() } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }

  const heading = <header className="admin-review-heading"><div><h1 id="family-alerts-title">Family alerts</h1>
    <p>A short Telegram message for your family when a booking is confirmed, moved or cancelled: the day, the times and when you will likely be home, in Spanish, with one of your love lines. Never the client's name, address, phone or price.</p></div></header>
  if (!bot) return <section className="admin-review" aria-labelledby="family-alerts-title">{heading}<p>The clients' Telegram bot is not set up yet, so family alerts cannot be sent. See the Telegram part of the setup guide.</p></section>
  if (chats === null) return <section className="admin-review" aria-labelledby="family-alerts-title">{heading}{error ? <><p role="alert">{error}</p><button onClick={look}>Try again</button></> : <p role="status">Loading…</p>}</section>
  return <section className="admin-review admin-client-telegram" aria-labelledby="family-alerts-title">
    {heading}
    {chats.length
      ? <ul className="admin-family-chats">{chats.map((chat, index) => <li key={chat.id}>
        <span>Telegram chat {index + 1}, connected {since(chat.linked_at)}</span>
        <button className="btn--small" disabled={busy} onClick={() => stop(chat.id)}>Switch off</button>
      </li>)}</ul>
      : <p className="admin-detail-hint">Nobody gets family alerts yet.</p>}
    {joined && <p role="status">Connected 💛 She will get a message the next time a booking is confirmed, moved or cancelled.</p>}
    {(!invite || joined) && <button className="btn--tonal" disabled={busy} onClick={makeLink}><Icon name="share" />{busy ? 'Making the link...' : chats.length ? 'Add someone else' : 'Get a link for your wife'}</button>}
    {invite && !joined && <>
      <p className="admin-detail-hint">Send her this link. When she taps it and presses Start in Telegram, the alerts start. It works once and lasts 24 hours.</p>
      <label className="admin-client-telegram-link">Telegram link<input readOnly value={invite.link} onFocus={event => event.target.select()} /></label>
      <div className="admin-payment-buttons">
        <a className="btn btn--tonal" href={familyInviteWhatsappLink(invite.text)} target="_blank" rel="noopener noreferrer"><Icon name="chat" />Send on WhatsApp</a>
        <button className="btn--tonal" onClick={copy}><Icon name="copy" />Copy link</button>
      </div>
      <p className="admin-detail-hint" role="status">Waiting for her to press Start. This page updates when she does.</p>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>
}
