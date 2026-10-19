import { createHmac, randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

// Connecting and disconnecting the Google Calendar copy (docs/google-calendar-sync-brief.md, part C). One address, /api/google-calendar:
//   GET  ?action=start       the Admin page asks where to go to sign in with Google (the Admin's Supabase sign-in in the Authorization header);
//   GET  ?code=…&state=…     Google sends the Admin back here: the sign-in is exchanged for a lasting one, kept in Vault, and the calendar made;
//   POST ?action=disconnect  the Admin's page: the sign-in is withdrawn at Google and forgotten here. The calendar stays in Google.
// Only the Admin can start or disconnect. Google's reply is trusted only with a signed, 10-minute "state" that matches a cookie set at the
// start, so nobody else can connect their own Google account. No token, code or secret is ever logged, returned or put in an address.

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const API = 'https://www.googleapis.com/calendar/v3'
export const SCOPES = 'https://www.googleapis.com/auth/calendar.app.created openid email'
export const CALENDAR_NAME = 'VadMassage bookings'
const STATE_MINUTES = 10
const COOKIE = 'vm_calendar_state'
const SETTINGS_PAGE = '/admin/settings/google-calendar'

const base = env => String(env.APP_BASE_URL || '').trim().replace(/\/+$/, '')
export const redirectUri = env => `${base(env)}/api/google-calendar`
const configured = env => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && base(env) && (env.SUPABASE_URL || env.VITE_SUPABASE_URL) && env.SUPABASE_SERVICE_ROLE_KEY)

const sign = (secret, text) => createHmac('sha256', secret).update(text).digest('base64url')
function sameText(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && timingSafeEqual(left, right)
}
// state = "<nonce>.<expiry ms>.<signature>", signed with the Google client secret, which only the server has.
export function makeState(secret, nonce, expires) { return `${nonce}.${expires}.${sign(secret, `${nonce}.${expires}`)}` }
export function readState(secret, state, at) {
  const [nonce, expires, signature] = String(state || '').split('.')
  if (!nonce || !expires || !signature || !sameText(signature, sign(secret, `${nonce}.${expires}`))) return null
  return Number(expires) > at ? nonce : null
}
const cookieOf = (header, name) => String(header || '').split(';').map(part => part.trim().split('=')).find(([key]) => key === name)?.[1] || ''

function json(response, status, body) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}
function back(response, result) {
  response.statusCode = 302
  response.setHeader('location', `${SETTINGS_PAGE}?calendar=${result}`)
  response.setHeader('set-cookie', `${COOKIE}=; Path=/api/google-calendar; HttpOnly; Secure; SameSite=Lax; Max-Age=0`)
  response.end()
}

// The caller must be the Admin, signed in properly (not as a guest).
async function adminFrom(request, client) {
  const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  const { data, error } = await client.auth.getUser(token)
  const user = data?.user
  if (error || !user || user.is_anonymous) return null
  const { data: row } = await client.from('admin_users').select('user_id').eq('user_id', user.id).maybeSingle()
  return row ? user : null
}

function emailFromIdToken(idToken) {
  // The id token comes straight from Google's token address over HTTPS, so its contents can be read without checking its signature.
  try { return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')).email || null } catch { return null }
}

export async function handleGoogleCalendar(request, response, { env = process.env, createServiceClient, fetchImpl = fetch, now = Date.now, randomBytes = cryptoRandomBytes } = {}) {
  response.setHeader('cache-control', 'no-store')
  const query = new URL(request.url, 'http://localhost').searchParams
  const callback = request.method === 'GET' && (query.has('code') || query.has('error'))
  if (!configured(env)) {
    if (callback) { back(response, 'error'); return }
    json(response, 503, { error: 'not set up' }); return
  }
  const client = createServiceClient
    ? createServiceClient(env.SUPABASE_URL || env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
    : createClient(env.SUPABASE_URL || env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  try {
    if (request.method === 'GET' && query.get('action') === 'start') {
      if (!(await adminFrom(request, client))) { json(response, 401, { error: 'Admin sign-in required' }); return }
      const nonce = randomBytes(24).toString('base64url')
      const state = makeState(env.GOOGLE_CLIENT_SECRET, nonce, now() + STATE_MINUTES * 60 * 1000)
      const url = `${AUTH_URL}?${new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(env), response_type: 'code', scope: SCOPES,
        access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state })}`
      response.setHeader('set-cookie', `${COOKIE}=${nonce}; Path=/api/google-calendar; HttpOnly; Secure; SameSite=Lax; Max-Age=${STATE_MINUTES * 60}`)
      json(response, 200, { url }); return
    }
    if (callback) {
      const nonce = readState(env.GOOGLE_CLIENT_SECRET, query.get('state'), now())
      if (!nonce || !sameText(nonce, cookieOf(request.headers.cookie, COOKIE))) { back(response, 'expired'); return }
      if (query.has('error') || !query.get('code')) { back(response, 'cancelled'); return }
      const exchanged = await fetchImpl(TOKEN_URL, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: query.get('code'), client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(env), grant_type: 'authorization_code' }).toString(),
      })
      if (!exchanged.ok) { back(response, 'error'); return }
      const tokens = await exchanged.json()
      const granted = String(tokens.scope || '').split(' ')
      if (!tokens.refresh_token || !granted.includes('https://www.googleapis.com/auth/calendar.app.created')) { back(response, 'no-access'); return }
      const call = (method, path, body) => fetchImpl(API + path, { method, headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      // The calendar made before is used again if Google still has it; otherwise a new one is made.
      const { data: connection } = await client.from('calendar_connection').select('calendar_id').maybeSingle()
      let calendarId = connection?.calendar_id || null
      if (calendarId && !(await call('GET', `/calendars/${encodeURIComponent(calendarId)}`)).ok) calendarId = null
      if (!calendarId) {
        const made = await call('POST', '/calendars', { summary: CALENDAR_NAME, timeZone: 'Europe/London', description: 'Copied from the VadMassage booking app. Changes made here are not kept.' })
        if (!made.ok) { back(response, 'error'); return }
        calendarId = (await made.json()).id
      }
      const { error } = await client.rpc('calendar_save_connection', { p_refresh_token: tokens.refresh_token, p_account_email: emailFromIdToken(tokens.id_token), p_calendar_id: calendarId })
      back(response, error ? 'error' : 'connected'); return
    }
    if (request.method === 'POST' && query.get('action') === 'disconnect') {
      if (!(await adminFrom(request, client))) { json(response, 401, { error: 'Admin sign-in required' }); return }
      // The sign-in is withdrawn at Google first (a failure there does not stop it being forgotten here).
      const { data: refreshToken } = await client.rpc('calendar_refresh_token')
      if (refreshToken) {
        await fetchImpl(REVOKE_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshToken }).toString() }).catch(() => null)
      }
      const { error } = await client.rpc('calendar_forget_connection', { p_status: 'disconnected' })
      if (error) { json(response, 500, { error: 'Could not disconnect' }); return }
      json(response, 200, { disconnected: true }); return
    }
    json(response, 404, { error: 'Not found' })
  } catch {
    if (callback) { back(response, 'error'); return }
    json(response, 500, { error: 'Something went wrong' })
  }
}
