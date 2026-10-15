// The clients-only Telegram bot. Telegram posts every message sent to the bot to api/telegram-webhook.js, after checking a secret that only
// Telegram and this site know. A client who pressed the Telegram button on their booking page arrives here with "/start <code>"; the database
// checks the code and links the chat. "/stop" ends it. Anything else gets a short, kind answer. Nothing else is read or kept: only the chat number.
import { timingSafeEqual } from 'node:crypto'

// Telegram gives a call that does not answer no limit, and one waiting call would hold up the rest of the sender, so every call to it is cut off.
export const CALL_LIMIT_MS = 8000

export const MESSAGES = {
  linked: "You're connected. I'll message you here about your appointments: when one is confirmed, moved or cancelled. Send /stop whenever you would like me to stop.",
  used: 'That link has already been used. If you would like updates here, open your booking page and press the Telegram button again.',
  expired: 'That link has expired. Open your booking page and press the Telegram button again to get a new one.',
  invalid: 'I could not use that link. Open your booking page and press the Telegram button again.',
  stopped: "Done. I won't send you any more updates here. You can turn them back on from your booking page whenever you like.",
  notStarted: "You weren't getting updates here, so there is nothing to stop. You can turn them on from your booking page.",
  hello: 'Hello, this is Vad. I send updates about your appointment here. To start, open your booking page and press the Telegram button.',
  help: 'I only send updates about your appointment. To change or cancel it, use the link in your email, or contact Vad.',
}

// Whose appointments the chat is now connected to, so that someone who was sent a link that is not theirs sees a name that is not theirs and can
// answer /stop. The name is the client's first name, from the database (kept short and on one line here too); without one the plain answer is used.
export function linkedMessage(firstName) {
  const name = typeof firstName === 'string' ? firstName.replace(/\s+/g, ' ').trim().slice(0, 40) : ''
  return name
    ? `You're connected, ${name}. I'll message you here when one of your appointments is confirmed, moved or cancelled. If you are not ${name}, or you would like me to stop, send /stop.`
    : MESSAGES.linked
}

// The token and the secret are pasted into a settings page, where a stray space or line break at the end is easy to leave: both are trimmed. A
// secret shorter than 16 characters is not accepted (the guide asks for 30 or more), and the token of the Admin's own bot is never accepted
// here: this bot is for clients only.
export function readTelegramConfig(env) {
  const token = String(env.TELEGRAM_CLIENT_BOT_TOKEN || '').trim()
  const secret = String(env.TELEGRAM_WEBHOOK_SECRET || '').trim()
  return {
    token: token && token !== String(env.TELEGRAM_BOT_TOKEN || '').trim() ? token : '',
    secret: secret.length >= 16 ? secret : '',
  }
}

// Telegram sends the secret in this header with every call. Compared in constant time, and a missing or different one is refused.
export function secretMatches(given, secret) {
  if (!secret || typeof given !== 'string' || !given) return false
  const expected = Buffer.from(secret)
  const actual = Buffer.from(given)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// "/start", "/start <code>" and "/stop" (also as "/start@TheBot ..."). A code is only letters, digits, _ and -, as Telegram allows.
export function parseCommand(text) {
  const match = /^\/(start|stop)(?:@[A-Za-z0-9_]+)?(?:\s+([A-Za-z0-9_-]{1,64}))?\s*$/i.exec(String(text ?? '').trim())
  if (!match) return null
  const name = match[1].toLowerCase()
  // "/stop" is just "/stop": anything after it is not a command we know, and it gets the help answer instead of ending anything.
  return name === 'stop' && match[2] ? null : { name, code: match[2] || '' }
}

export function createWebhookHandler({ client, token, fetchImpl = fetch }) {
  // Best effort: the answer to a person is nice to have, and the linking has already happened by the time it is sent.
  async function reply(chat, text) {
    try {
      await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(CALL_LIMIT_MS),
      })
    } catch { /* A reply that does not arrive is not worth failing the call for. */ }
  }
  return async function handleUpdate(update) {
    const message = update?.message
    const chat = message?.chat?.id
    // Only a person talking to the bot in a private chat; groups, channels and edits are ignored.
    if (!message || message.chat?.type !== 'private' || !Number.isSafeInteger(chat) || typeof message.text !== 'string') return { handled: false }
    const command = parseCommand(message.text)
    if (command?.name === 'start' && command.code) {
      const { data, error } = await client.rpc('link_client_telegram', { p_token: command.code, p_chat_id: chat })
      if (error) throw new Error('Could not link the chat')
      const status = Object.hasOwn(MESSAGES, data?.status) ? data.status : 'invalid'
      await reply(chat, status === 'linked' ? linkedMessage(data?.first_name) : MESSAGES[status])
      return { handled: true, status }
    }
    if (command?.name === 'start') { await reply(chat, MESSAGES.hello); return { handled: true, status: 'hello' } }
    if (command?.name === 'stop') {
      const { data, error } = await client.rpc('stop_client_telegram', { p_chat_id: chat })
      if (error) throw new Error('Could not stop the chat')
      await reply(chat, data > 0 ? MESSAGES.stopped : MESSAGES.notStarted)
      return { handled: true, status: data > 0 ? 'stopped' : 'notStarted' }
    }
    await reply(chat, MESSAGES.help)
    return { handled: true, status: 'help' }
  }
}
