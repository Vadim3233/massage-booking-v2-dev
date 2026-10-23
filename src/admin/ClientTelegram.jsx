import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../ui/icons.jsx'
import { cleanUsername, telegramLink } from '../client/booking/telegramLink.js'
import { INVITE_POLL_FOR_MS, INVITE_POLL_MS, inviteMessage, inviteWhatsappLink } from './telegramInvite.js'
import { toast } from '../ui/toast.js'

// Telegram updates, on a client's profile. A client who did not press "Get updates on Telegram" themselves can be sent the link: the Admin makes a
// one-time link here and shares it on WhatsApp or copies it. Once the client has pressed Start the profile says so. Like the client's own box it is
// shown only when the clients-only bot is set up (its public username is a site setting) and the database can answer.
export default function ClientTelegram({ client, api, username = import.meta.env.VITE_TELEGRAM_CLIENT_BOT_USERNAME }) {
  const bot = cleanUsername(username)
  const [linked, setLinked] = useState(null)
  const [invite, setInvite] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  const pollUntil = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const look = useCallback(async () => {
    try {
      const status = await api.telegramStatus(client.id)
      if (alive.current) setLinked(Boolean(status?.linked))
    } catch { /* the box simply stays as it was */ }
  }, [api, client.id])
  useEffect(() => {
    if (!bot) return undefined
    const again = () => { if (document.visibilityState === 'visible') look() }
    again()
    document.addEventListener('visibilitychange', again)
    window.addEventListener('focus', again)
    return () => { document.removeEventListener('visibilitychange', again); window.removeEventListener('focus', again) }
  }, [bot, look])
  useEffect(() => {
    if (!invite || linked) return undefined
    const timer = setInterval(() => { if (Date.now() <= pollUntil.current && document.visibilityState === 'visible') look() }, INVITE_POLL_MS)
    return () => clearInterval(timer)
  }, [invite, linked, look])

  async function makeLink() {
    setBusy(true); setError('')
    try {
      const link = telegramLink(bot, await api.createTelegramLink(client.id))
      if (!link) throw new Error('Could not make the link. Please try again.')
      pollUntil.current = Date.now() + INVITE_POLL_FOR_MS
      if (alive.current) setInvite({ link, text: inviteMessage(client.first_name, link) })
    } catch (failure) { if (alive.current) setError(failure.message) } finally { if (alive.current) setBusy(false) }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(invite.link); toast('Telegram link copied') } catch { setError('Could not copy. Select the link and copy it.') }
  }

  if (!bot || linked === null) return null
  const whatsapp = invite && inviteWhatsappLink(client.phone, invite.text)
  return <section aria-labelledby="telegram-title" className="admin-client-telegram"><h2 id="telegram-title">Telegram updates</h2>
    {linked
      ? <p>Telegram is on. {client.first_name || 'This client'} gets their booking updates there as well as by email.</p>
      : <>
        <p className="admin-detail-hint">Not on Telegram yet. Send {client.first_name || 'them'} a one-time link: when they press Start in Telegram, their booking updates come there too. The link works once and lasts 24 hours, so send it only to them.</p>
        {!invite && <button className="btn--tonal" disabled={busy} onClick={makeLink}><Icon name="share" />{busy ? 'Making the link...' : 'Get Telegram link'}</button>}
        {invite && <>
          <label className="admin-client-telegram-link">Telegram link<input readOnly value={invite.link} onFocus={event => event.target.select()} /></label>
          <div className="admin-payment-buttons">
            {whatsapp && <a className="btn btn--tonal" href={whatsapp} target="_blank" rel="noopener noreferrer"><Icon name="chat" />Send on WhatsApp</a>}
            <button className="btn--tonal" onClick={copy}><Icon name="copy" />Copy link</button>
            <button className="btn--small" disabled={busy} onClick={makeLink}>Make a new link</button>
          </div>
          {!whatsapp && <p className="admin-detail-hint">There is no phone number for WhatsApp, so copy the link instead.</p>}
          <p className="admin-detail-hint" role="status">Waiting for {client.first_name || 'them'} to press Start. This page updates when they do.</p>
        </>}
      </>}
    {error && <p role="alert">{error}</p>}
  </section>
}
