// Delivers queued Telegram and email notifications. The database writes every message; this only sends
// them and records the outcome. Secrets come from the environment and never appear in results or errors.
import { composeEmailHtml } from './emailHtml.js'
import { CALL_LIMIT_MS } from './telegramWebhook.js'

const TELEGRAM_LIMIT = 4000

export function readConfig(env) {
  const base = String(env.APP_BASE_URL || '').trim().replace(/\/+$/, '')
  // The clients-only bot has a token of its own, pasted into a settings page (so it is trimmed); the Admin's bot is never accepted in its place.
  const clientToken = String(env.TELEGRAM_CLIENT_BOT_TOKEN || '').trim()
  return {
    appBaseUrl: base,
    telegram: { token: env.TELEGRAM_BOT_TOKEN || '', chatId: env.ADMIN_TELEGRAM_CHAT_ID || '' },
    // The clients-only bot: its own token, and a chat for each client who linked one (never the Admin's chat above).
    telegramClient: { token: clientToken && clientToken !== String(env.TELEGRAM_BOT_TOKEN || '').trim() ? clientToken : '' },
    email: { apiKey: env.RESEND_API_KEY || '', from: env.EMAIL_FROM || '', adminTo: env.ADMIN_ALERT_EMAIL || '', replyTo: env.EMAIL_REPLY_TO || '' },
  }
}

export function enabledChannels(config) {
  const channels = []
  if (config.telegram.token && config.telegram.chatId) channels.push('telegram')
  if (config.telegramClient.token) channels.push('telegram_client')
  if (config.email.apiKey && config.email.from) channels.push('email')
  return channels
}

export function composeMessage(row, config) {
  const url = config.appBaseUrl && row.link_path ? `${config.appBaseUrl}${row.link_path}` : ''
  let body = row.body
  if (body.includes('{link}')) {
    body = url
      ? body.replaceAll('{link}', url)
      : body.split('\n').filter(line => !line.includes('{link}')).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  } else if (url && row.audience === 'admin') {
    body = `${body}\n\nOpen the booking: ${url}`
  }
  return { url, title: row.title, body }
}

function scrub(message, secrets) {
  let text = String(message || 'Unknown error')
  for (const secret of secrets) if (secret) text = text.split(secret).join('[hidden]')
  return text.slice(0, 300)
}

async function sendTelegram(row, message, config, fetchImpl) {
  // This is the Admin's chat: a message for a client never goes here (client messages have their own channel and bot).
  if (row.audience !== 'admin') throw new Error('Telegram: this message is not for the Admin')
  const text = `${message.title}\n\n${message.body}`.slice(0, TELEGRAM_LIMIT)
  const payload = { chat_id: config.telegram.chatId, text, disable_web_page_preview: true }
  // Telegram only accepts public https links on buttons.
  if (message.url.startsWith('https://')) payload.reply_markup = { inline_keyboard: [[{ text: 'Open booking', url: message.url }]] }
  const response = await fetchImpl(`https://api.telegram.org/bot${config.telegram.token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(CALL_LIMIT_MS),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || !result.ok) throw new Error(`Telegram: ${result.description || `HTTP ${response.status}`}`)
}

// A message to a client's own chat, with the clients-only bot. The recipient is the chat the client linked. A chat that has blocked the bot
// (or no longer exists) is not tried again: its link is ended, so nothing more is queued for it, and the failure is recorded as usual.
async function sendTelegramClient(row, message, config, fetchImpl, client) {
  if (row.audience !== 'client') throw new Error('Telegram: this message is not for a client')
  const chat = Number(row.recipient)
  if (!Number.isSafeInteger(chat)) throw new Error('Telegram: no chat to send to')
  const text = `${message.title}\n\n${message.body}`.slice(0, TELEGRAM_LIMIT)
  // Cut off if Telegram does not answer, so one waiting call cannot hold up every message after it.
  const response = await fetchImpl(`https://api.telegram.org/bot${config.telegramClient.token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(CALL_LIMIT_MS),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || !result.ok) {
    if (result.error_code === 403 || (result.error_code === 400 && /chat not found/i.test(result.description || ''))) {
      await client.rpc('stop_client_telegram', { p_chat_id: chat }).then(() => {}, () => {})
    }
    throw new Error(`Telegram: ${result.description || `HTTP ${response.status}`}`)
  }
}

async function sendEmail(row, message, config, fetchImpl) {
  const to = row.audience === 'admin' ? config.email.adminTo : row.recipient
  if (!to) throw new Error('ADMIN_ALERT_EMAIL is not set')
  const payload = { from: config.email.from, to: [to], subject: row.audience === 'admin' ? `[VadMassage] ${message.title}` : message.title, text: message.body }
  if (row.audience === 'client') {
    // A client's email also goes out in the look of the booking pages, beside the plain text. It is made from the message as written (with its
    // "{link}") and the private link, and it never holds the email back: if it cannot be made the plain text goes alone.
    try { payload.html = composeEmailHtml({ title: message.title, body: row.body, url: message.url, canReply: Boolean(config.email.replyTo) }) } catch { /* plain text only */ }
    if (config.email.replyTo) payload.reply_to = config.email.replyTo
  }
  const response = await fetchImpl('https://api.resend.com/emails', {
    // The row id as the idempotency key: if this send went through but its result was not recorded, the retry is not sent twice.
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.email.apiKey}`, 'idempotency-key': `delivery-${row.id}` },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(CALL_LIMIT_MS),
  })
  if (!response.ok) {
    const result = await response.json().catch(() => ({}))
    throw new Error(`Email: ${result.message || `HTTP ${response.status}`}`)
  }
}

// A client's email about a booking gets a private link to that booking, made now, just before it is sent. The code goes after a # so it
// never reaches a web server or a log, only the browser, and it is kept nowhere but in the message (the database holds only its hash).
// If a code cannot be made the plain link goes instead: the message is never held back for it. Nothing else gets a code: not the Admin's
// messages, not a message that is not an email (a Telegram message would show it in the text and on the button), and not an email with
// no public address to put the link on (the link is dropped from it, so the code would be made for nothing).
async function withPrivateLink(row, client, config) {
  const path = String(row.link_path || '')
  if (row.audience !== 'client' || row.channel !== 'email' || !config.appBaseUrl || !path.startsWith('/account?booking=')) return { row, code: '' }
  const booking = new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('booking')
  if (!booking) return { row, code: '' }
  try {
    const { data, error } = await client.rpc('mint_booking_access_token', { p_booking_id: booking })
    if (error || typeof data !== 'string' || !data) return { row, code: '' }
    return { row: { ...row, link_path: `${path}#key=${data}` }, code: data }
  } catch { return { row, code: '' } }
}

export function createDispatcher({ client, config, fetchImpl = fetch }) {
  const secrets = [config.telegram.token, config.telegramClient.token, config.email.apiKey]
  return {
    async dispatch({ limit = 10 } = {}) {
      const channels = enabledChannels(config)
      if (!channels.length) return { claimed: 0, sent: 0, failed: 0, channels }
      const { data: rows, error } = await client.rpc('claim_notification_deliveries', { p_limit: limit, p_channels: channels })
      if (error) throw new Error('Could not read the notification queue.')
      let sent = 0, failed = 0
      for (const row of rows) {
        let failure = null
        let code = ''
        try {
          const linked = await withPrivateLink(row, client, config)
          code = linked.code
          const message = composeMessage(linked.row, config)
          if (row.channel === 'telegram') await sendTelegram(row, message, config, fetchImpl)
          else if (row.channel === 'telegram_client') await sendTelegramClient(row, message, config, fetchImpl, client)
          else if (row.channel === 'email') await sendEmail(row, message, config, fetchImpl)
          else throw new Error('Unsupported channel')
        } catch (caught) { failure = scrub(caught?.message, code ? [...secrets, code] : secrets) }
        const { error: completeError } = await client.rpc('complete_notification_delivery', { p_id: row.id, p_ok: !failure, p_error: failure })
        if (completeError) failure = failure || 'Could not record the result'
        if (failure) failed += 1; else sent += 1
      }
      return { claimed: rows.length, sent, failed, channels }
    },
  }
}
