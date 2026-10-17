import { useCallback, useEffect, useRef, useState } from 'react'
import { telegramApi } from '../telegramApi.js'
import { cleanUsername, POLL_FOR_MS, POLL_MS, shouldRefresh, telegramLink } from '../telegramLink.js'

const HIDDEN = { phase: 'hidden', link: '', mintedAt: 0 }

// What the box knows: not yet (checking), a button that works (ready), a chat already linked (linked), or nothing to show (hidden).
// It looks when the page opens, again whenever the client comes back to the page (from Telegram, say), and every few seconds for a few minutes
// after the button is shown or pressed. A code an hour old is replaced the next time the page is looked at.
function useTelegramLink(name, api) {
  const [view, setView] = useState({ phase: 'checking', link: '', mintedAt: 0 })
  const latest = useRef(view)
  const alive = useRef(true)
  const running = useRef(false)
  const pollUntil = useRef(0)
  // Pressing the button starts the few minutes of looking again, however long the page had been open before.
  const opened = useCallback(() => { pollUntil.current = Date.now() + POLL_FOR_MS }, [])
  useEffect(() => { latest.current = view })
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const look = useCallback(async () => {
    // One look at a time: a second one that starts while the first is still asking would make a second code (the page opening and the window
    // gaining focus at once, or the page being set up twice in development).
    if (running.current) return
    running.current = true
    try {
      if (await api.status()) { if (alive.current) setView({ phase: 'linked', link: '', mintedAt: 0 }); return }
      const shown = latest.current
      if (shown.phase === 'ready' && !shouldRefresh(shown.mintedAt, Date.now())) return
      const link = telegramLink(name, await api.createLink())
      if (alive.current) setView(link ? { phase: 'ready', link, mintedAt: Date.now() } : HIDDEN)
    } catch {
      // A button that cannot work is worse than none, so on any trouble the box goes away (unless one that works is already showing).
      if (alive.current) setView(previous => (previous.phase === 'ready' || previous.phase === 'linked' ? previous : HIDDEN))
    } finally { running.current = false }
  }, [api, name])
  useEffect(() => {
    if (!name) return undefined
    const again = () => { if (document.visibilityState === 'visible') look() }
    again()
    document.addEventListener('visibilitychange', again)
    window.addEventListener('focus', again)
    return () => { document.removeEventListener('visibilitychange', again); window.removeEventListener('focus', again) }
  }, [name, look])
  useEffect(() => {
    if (view.phase !== 'ready') return undefined
    pollUntil.current = Math.max(pollUntil.current, Date.now() + POLL_FOR_MS)
    const timer = setInterval(() => {
      if (Date.now() <= pollUntil.current && document.visibilityState === 'visible') look()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [view.phase, look])
  return { view, opened }
}

// "Get updates on Telegram", near the top of a booking that is confirmed or waiting for Vad. It is shown only when the clients-only bot is set up
// (its public username is a site setting) and the database can answer; a client never sees an error from it.
export default function TelegramBox({ username = import.meta.env.VITE_TELEGRAM_CLIENT_BOT_USERNAME, api = telegramApi }) {
  const name = cleanUsername(username)
  const { view, opened } = useTelegramLink(name, api)
  if (!name || view.phase === 'checking' || view.phase === 'hidden') return null
  const linked = view.phase === 'linked'
  return <section className="telegram-box" data-state={view.phase} aria-labelledby="telegram-box-title">
    <h2 id="telegram-box-title">{linked ? "You're connected on Telegram" : 'Get updates on Telegram'}</h2>
    {linked
      ? <p>I'll message you there when your appointment is confirmed, moved or cancelled. Send /stop in the chat to turn it off.</p>
      : <>
        <p>I'll message you when your appointment is confirmed, moved or cancelled. Press the button, then press Start in Telegram. It's optional: you'll get the email either way.</p>
        <a className="btn btn--tonal btn--block" href={view.link} target="_blank" rel="noopener noreferrer" onClick={opened}>Open Telegram</a>
        {/* Telegram's own page for getting the app on any phone or computer. */}
        <p>You need the free Telegram app. Don't have it? <a href="https://telegram.org/dl" target="_blank" rel="noopener noreferrer">Get it here</a>, then come back to this page and press the button again.</p>
        <p className="fine">This page will tell you when you're connected.</p>
      </>}
    {/* Said aloud to a screen reader when the chat gets linked. */}
    <p className="sr-only" role="status">{linked ? "You're connected on Telegram." : ''}</p>
  </section>
}
