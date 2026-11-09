import { createClient } from '@supabase/supabase-js'
import { handleCalendarLink } from '../server/calendarLink.js'

// The "Add to your calendar" page and file from the share message (see server/calendarLink.js).
export async function handle(request, response, { env = process.env, createServiceClient } = {}) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_SERVICE_ROLE_KEY
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.statusCode = 405; response.end('Method not allowed'); return }
  if (!url || !key) { response.statusCode = 500; response.setHeader('content-type', 'text/plain; charset=utf-8'); response.end('Calendar links are not set up yet.'); return }
  const client = createServiceClient ? createServiceClient(url, key) : createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const host = request.headers['x-forwarded-host'] || request.headers.host
  const origin = host ? `https://${host}` : ''
  try { await handleCalendarLink(request, response, { client, origin }) } catch { response.statusCode = 500; response.end('Please try again.') }
}

export default function handler(request, response) { return handle(request, response) }
