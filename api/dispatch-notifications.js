import { timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { createDispatcher, readConfig } from '../server/notifications.js'

function authorised(header, secret) {
  if (!secret || !header) return false
  const expected = Buffer.from(`Bearer ${secret}`)
  const given = Buffer.from(String(header))
  return given.length === expected.length && timingSafeEqual(given, expected)
}

// What is waiting is sent ten at a time, for a few rounds. With the sender called only once a day, a morning's reminders must not wait for tomorrow.
async function sendAll(dispatcher, { rounds = 5, limit = 10, budgetMs = 6000, now = Date.now } = {}) {
  const started = now()
  let total = null
  for (let round = 0; round < rounds; round += 1) {
    const result = await dispatcher.dispatch({ limit })
    total = total ? { ...total, claimed: total.claimed + result.claimed, sent: total.sent + result.sent, failed: total.failed + result.failed } : result
    if (result.claimed < limit || now() - started > budgetMs) break
  }
  return total
}

// Exported separately so it can be tested without a server.
export async function handle(request, response, { env = process.env, createServiceClient, fetchImpl } = {}) {
  response.setHeader('cache-control', 'no-store')
  if (!['GET', 'POST'].includes(request.method)) { response.statusCode = 405; response.end(JSON.stringify({ error: 'Method not allowed' })); return }
  if (!authorised(request.headers.authorization, env.CRON_SECRET)) { response.statusCode = 401; response.end(JSON.stringify({ error: 'Unauthorised' })); return }
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) { response.statusCode = 500; response.end(JSON.stringify({ error: 'The sender is not configured' })); return }
  try {
    const client = createServiceClient ? createServiceClient(url, key) : createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    // Repeating bookings first, so the messages they create go out in the same run. A problem here never stops the sender.
    const repeats = await client.rpc('run_series_maintenance').then(({ data, error }) => (error ? { failed: true } : data), () => ({ failed: true }))
    // Then the morning reminders that are due, for the same reason. It does nothing until it is time, and never reminds twice.
    const reminders = await client.rpc('plan_day_of_reminders').then(({ data, error }) => (error ? { failed: true } : { made: data }), () => ({ failed: true }))
    const summary = { ...(await sendAll(createDispatcher({ client, config: readConfig(env), fetchImpl }))), repeats, reminders }
    response.statusCode = 200
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(summary))
  } catch {
    response.statusCode = 500
    response.end(JSON.stringify({ error: 'The sender could not run' }))
  }
}

export default function handler(request, response) { return handle(request, response) }
