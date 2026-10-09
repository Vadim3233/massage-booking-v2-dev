// Delivers queued Telegram and email notifications. The database writes every message; this only sends
// them and records the outcome. Secrets come from the environment and never appear in results or errors.

const TELEGRAM_LIMIT = 4000

export function readConfig(env) {
  const base = String(env.APP_BASE_URL || '').trim().replace(/\/+$/, '')
  return {
    appBaseUrl: base,
    telegram: { token: env.TELEGRAM_BOT_TOKEN || '', chatId: env.ADMIN_TELEGRAM_CHAT_ID || '' },
    email: { apiKey: env.RESEND_API_KEY || '', from: env.EMAIL_FROM || '', adminTo: env.ADMIN_ALERT_EMAIL || '', replyTo: env.EMAIL_REPLY_TO || '' },
  }
}

export function enabledChannels(config) {
  const channels = []
  if (config.telegram.token && config.telegram.chatId) channels.push('telegram')
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
  const text = `${message.title}\n\n${message.body}`.slice(0, TELEGRAM_LIMIT)
  const payload = { chat_id: config.telegram.chatId, text, disable_web_page_preview: true }
  // Telegram only accepts public https links on buttons.
  if (message.url.startsWith('https://')) payload.reply_markup = { inline_keyboard: [[{ text: 'Open booking', url: message.url }]] }
  const response = await fetchImpl(`https://api.telegram.org/bot${config.telegram.token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || !result.ok) throw new Error(`Telegram: ${result.description || `HTTP ${response.status}`}`)
}

async function sendEmail(row, message, config, fetchImpl) {
  const to = row.audience === 'admin' ? config.email.adminTo : row.recipient
  if (!to) throw new Error('ADMIN_ALERT_EMAIL is not set')
  const payload = { from: config.email.from, to: [to], subject: row.audience === 'admin' ? `[VadMassage] ${message.title}` : message.title, text: message.body }
  if (row.audience === 'client' && config.email.replyTo) payload.reply_to = config.email.replyTo
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.email.apiKey}` }, body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const result = await response.json().catch(() => ({}))
    throw new Error(`Email: ${result.message || `HTTP ${response.status}`}`)
  }
}

export function createDispatcher({ client, config, fetchImpl = fetch }) {
  const secrets = [config.telegram.token, config.email.apiKey]
  return {
    async dispatch({ limit = 10 } = {}) {
      const channels = enabledChannels(config)
      if (!channels.length) return { claimed: 0, sent: 0, failed: 0, channels }
      const { data: rows, error } = await client.rpc('claim_notification_deliveries', { p_limit: limit, p_channels: channels })
      if (error) throw new Error('Could not read the notification queue.')
      let sent = 0, failed = 0
      for (const row of rows) {
        let failure = null
        try {
          const message = composeMessage(row, config)
          if (row.channel === 'telegram') await sendTelegram(row, message, config, fetchImpl)
          else if (row.channel === 'email') await sendEmail(row, message, config, fetchImpl)
          else throw new Error('Unsupported channel')
        } catch (caught) { failure = scrub(caught?.message, secrets) }
        const { error: completeError } = await client.rpc('complete_notification_delivery', { p_id: row.id, p_ok: !failure, p_error: failure })
        if (completeError) failure = failure || 'Could not record the result'
        if (failure) failed += 1; else sent += 1
      }
      return { claimed: rows.length, sent, failed, channels }
    },
  }
}
