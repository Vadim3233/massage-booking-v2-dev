import { timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { createDispatcher, readConfig } from '../server/notifications.js'

function authorised(header, secret) {
  if (!secret || !header) return false
  const expected = Buffer.from(`Bearer ${secret}`)
  const given = Buffer.from(String(header))
  return given.length === expected.length && timingSafeEqual(given, expected)
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
    const summary = await createDispatcher({ client, config: readConfig(env), fetchImpl }).dispatch()
    response.statusCode = 200
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(summary))
  } catch {
    response.statusCode = 500
    response.end(JSON.stringify({ error: 'The sender could not run' }))
  }
}

export default function handler(request, response) { return handle(request, response) }
