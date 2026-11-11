// Sends the family alerts (supabase/migrations/20261206100000_family_telegram_alerts.sql): short messages to the owner's family when a
// booking is confirmed, moved or cancelled. The database writes every message; this only sends them, with the clients' Telegram bot, and
// records how it went. A chat that has blocked the bot (or no longer exists) is switched off, so nothing more is written for it.
import { CALL_LIMIT_MS } from './telegramWebhook.js'

const TELEGRAM_LIMIT = 4000

export function createFamilySender({ client, token, fetchImpl = fetch }) {
  const scrub = message => String(message || 'Unknown error').split(token).join('[hidden]').slice(0, 300)
  async function send(row) {
    const chat = Number(row.chat_id)
    if (!Number.isSafeInteger(chat)) throw new Error('Telegram: no chat to send to')
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: String(row.body).slice(0, TELEGRAM_LIMIT), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(CALL_LIMIT_MS),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok || !result.ok) {
      if (result.error_code === 403 || (result.error_code === 400 && /chat not found/i.test(result.description || ''))) {
        await client.rpc('stop_family_telegram', { p_chat_id: chat }).then(() => {}, () => {})
      }
      throw new Error(`Telegram: ${result.description || `HTTP ${response.status}`}`)
    }
  }
  return {
    // Until the database update is applied there is nothing to claim: that is not a failure, the alerts are simply not there yet.
    async run({ limit = 10 } = {}) {
      if (!token) return { claimed: 0, sent: 0, failed: 0 }
      const { data: rows, error } = await client.rpc('claim_family_telegram_messages', { p_limit: limit })
      if (error) return { claimed: 0, sent: 0, failed: 0, unavailable: true }
      let sent = 0, failed = 0
      for (const row of rows || []) {
        let failure = null
        try { await send(row) } catch (caught) { failure = scrub(caught?.message) }
        const { error: completeError } = await client.rpc('complete_family_telegram_message', { p_id: row.id, p_ok: !failure, p_error: failure })
        if (completeError) failure = failure || 'Could not record the result'
        if (failure) failed += 1; else sent += 1
      }
      return { claimed: (rows || []).length, sent, failed }
    },
  }
}
