import { createClient } from '@supabase/supabase-js'
import { createWebhookHandler, readTelegramConfig, secretMatches } from '../server/telegramWebhook.js'

// The clients-only Telegram bot's webhook (see server/telegramWebhook.js). Telegram calls it with a secret in a header; anything without the
// right secret is refused before it is read. Once it is accepted the answer is always "ok" unless something on our side failed, so Telegram
// only tries again when we really did not manage.
function readUpdate(request) {
  const body = request.body
  if (body && typeof body === 'object') return body
  if (typeof body === 'string') { try { return JSON.parse(body) } catch { return null } }
  return null
}

// Exported separately so it can be tested without a server.
export async function handle(request, response, { env = process.env, createServiceClient, fetchImpl } = {}) {
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-type', 'application/json')
  if (request.method !== 'POST') { response.statusCode = 405; response.end(JSON.stringify({ error: 'Method not allowed' })); return }
  const config = readTelegramConfig(env)
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_SERVICE_ROLE_KEY
  if (!config.token || !config.secret || !url || !key) { response.statusCode = 500; response.end(JSON.stringify({ error: 'The bot is not configured' })); return }
  if (!secretMatches(request.headers['x-telegram-bot-api-secret-token'], config.secret)) { response.statusCode = 401; response.end(JSON.stringify({ error: 'Unauthorised' })); return }
  try {
    const client = createServiceClient ? createServiceClient(url, key) : createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    const update = readUpdate(request)
    if (update) await createWebhookHandler({ client, token: config.token, fetchImpl })(update)
    response.statusCode = 200
    response.end(JSON.stringify({ ok: true }))
  } catch {
    response.statusCode = 500
    response.end(JSON.stringify({ error: 'The bot could not process that' }))
  }
}

export default function handler(request, response) { return handle(request, response) }
