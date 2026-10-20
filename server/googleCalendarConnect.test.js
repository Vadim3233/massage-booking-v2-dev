import { describe, expect, it } from 'vitest'
import { handleGoogleCalendar, makeState, readState, SCOPES } from './googleCalendarConnect.js'

const env = { GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'CLIENT-SECRET', APP_BASE_URL: 'https://booking.example.com/', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'SERVICE-KEY' }
const NOW = 1_800_000_000_000
const users = { 'admin-jwt': { id: 'admin-1' }, 'client-jwt': { id: 'client-1' }, 'guest-jwt': { id: 'admin-1', is_anonymous: true } }
const idToken = `x.${Buffer.from(JSON.stringify({ email: 'owner@gmail.example' })).toString('base64url')}.y`

function fakeDatabase({ calendarId = null, refreshToken = 'OLD-REFRESH' } = {}) {
  const rpcs = []
  return {
    rpcs,
    auth: { getUser: async token => (users[token] ? { data: { user: users[token] }, error: null } : { data: { user: null }, error: { message: 'bad jwt' } }) },
    from: table => {
      const query = { filters: {} }
      const chain = {
        select: () => chain,
        eq: (column, value) => { query.filters[column] = value; return chain },
        maybeSingle: async () => {
          if (table === 'admin_users') return { data: query.filters.user_id === 'admin-1' ? { user_id: 'admin-1' } : null, error: null }
          if (table === 'calendar_connection') return { data: calendarId ? { calendar_id: calendarId } : null, error: null }
          return { data: null, error: null }
        },
      }
      return chain
    },
    rpc: async (name, args) => { rpcs.push([name, args]); return name === 'calendar_refresh_token' ? { data: refreshToken, error: null } : { data: null, error: null } },
  }
}
function fakeGoogle({ token = { access_token: 'ACCESS', refresh_token: 'NEW-REFRESH', id_token: idToken, scope: `${SCOPES.split(' ')[0]} openid https://www.googleapis.com/auth/userinfo.email` }, tokenStatus = 200, existing = null } = {}) {
  const calls = []
  const reply = (status, body = {}) => ({ ok: status < 300, status, json: async () => body })
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      calls.push([init.method || 'GET', url, init.body ? String(init.body) : ''])
      if (url === 'https://oauth2.googleapis.com/token') return reply(tokenStatus, token)
      if (url === 'https://oauth2.googleapis.com/revoke') return reply(200)
      if (url.endsWith('/calendars') && init.method === 'POST') return reply(200, { id: 'new-calendar@group.calendar.google.com' })
      if (url.includes('/calendars/')) return reply(decodeURIComponent(url).endsWith(existing || '\u0000') ? 200 : 404)
      return reply(400)
    },
  }
}
async function call({ method = 'GET', url, headers = {}, database = fakeDatabase(), google = fakeGoogle(), environment = env }) {
  const response = { headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value }, end(body = '') { this.body = body } }
  await handleGoogleCalendar({ method, url, headers }, response, { env: environment, createServiceClient: () => database, fetchImpl: google.fetchImpl, now: () => NOW, randomBytes: () => Buffer.from('n'.repeat(24)) })
  return response
}
const nonce = Buffer.from('n'.repeat(24)).toString('base64url')
const goodState = makeState(env.GOOGLE_CLIENT_SECRET, nonce, NOW + 60_000)
const cookie = `other=1; vm_calendar_state=${nonce}`
const secrets = /CLIENT-SECRET|SERVICE-KEY|NEW-REFRESH|OLD-REFRESH|ACCESS|admin-jwt/

describe('starting the Google sign-in', () => {
  it('is only for the Admin, signed in properly', async () => {
    for (const headers of [{}, { authorization: 'Bearer client-jwt' }, { authorization: 'Bearer guest-jwt' }, { authorization: 'Bearer nonsense' }]) {
      expect((await call({ url: '/api/google-calendar?action=start', headers })).statusCode).toBe(401)
    }
  })
  it('sends the Admin to Google for a lasting sign-in to its own calendar only, with a signed state tied to a cookie', async () => {
    const response = await call({ url: '/api/google-calendar?action=start', headers: { authorization: 'Bearer admin-jwt' } })
    expect(response.statusCode).toBe(200)
    const url = new URL(JSON.parse(response.body).url)
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: 'client-id', redirect_uri: 'https://booking.example.com/api/google-calendar', response_type: 'code',
      scope: 'https://www.googleapis.com/auth/calendar.app.created openid email', access_type: 'offline', prompt: 'consent' })
    expect(readState(env.GOOGLE_CLIENT_SECRET, url.searchParams.get('state'), NOW)).toBe(nonce)
    expect(response.headers['set-cookie']).toBe(`vm_calendar_state=${nonce}; Path=/api/google-calendar; HttpOnly; Secure; SameSite=Lax; Max-Age=600`)
    expect(response.body + JSON.stringify(response.headers)).not.toMatch(secrets)
  })
  it('says plainly when the Google codes are not set yet', async () => {
    const response = await call({ url: '/api/google-calendar?action=start', headers: { authorization: 'Bearer admin-jwt' }, environment: { ...env, GOOGLE_CLIENT_SECRET: '' } })
    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toEqual({ error: 'not set up' })
  })
})

describe('coming back from Google', () => {
  const back = (query, headers = { cookie }, options = {}) => call({ url: `/api/google-calendar?${new URLSearchParams(query)}`, headers, ...options })
  it('keeps the lasting sign-in in Vault, makes the VadMassage bookings calendar, and returns to the settings page', async () => {
    const database = fakeDatabase()
    const google = fakeGoogle()
    const response = await back({ code: 'CODE', state: goodState }, { cookie }, { database, google })
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/admin/settings/google-calendar?calendar=connected')
    expect(response.headers['set-cookie']).toMatch(/^vm_calendar_state=; .*Max-Age=0$/)
    const exchange = google.calls.find(([, url]) => url === 'https://oauth2.googleapis.com/token')
    expect(Object.fromEntries(new URLSearchParams(exchange[2]))).toEqual({ code: 'CODE', client_id: 'client-id', client_secret: 'CLIENT-SECRET', redirect_uri: 'https://booking.example.com/api/google-calendar', grant_type: 'authorization_code' })
    const made = google.calls.find(([method, url]) => method === 'POST' && url.endsWith('/calendars'))
    expect(JSON.parse(made[2])).toMatchObject({ summary: 'VadMassage bookings', timeZone: 'Europe/London' })
    expect(database.rpcs).toEqual([['calendar_save_connection', { p_refresh_token: 'NEW-REFRESH', p_account_email: 'owner@gmail.example', p_calendar_id: 'new-calendar@group.calendar.google.com' }]])
    expect(response.headers.location + JSON.stringify(response.headers)).not.toMatch(secrets)
  })
  it('uses the calendar it made before when Google still has it, and makes a new one when it has gone', async () => {
    const kept = fakeDatabase({ calendarId: 'old@group.calendar.google.com' })
    const google = fakeGoogle({ existing: 'old@group.calendar.google.com' })
    await back({ code: 'CODE', state: goodState }, { cookie }, { database: kept, google })
    expect(kept.rpcs[0][1].p_calendar_id).toBe('old@group.calendar.google.com')
    expect(google.calls.some(([method, url]) => method === 'POST' && url.endsWith('/calendars'))).toBe(false)
    const gone = fakeDatabase({ calendarId: 'old@group.calendar.google.com' })
    await back({ code: 'CODE', state: goodState }, { cookie }, { database: gone, google: fakeGoogle() })
    expect(gone.rpcs[0][1].p_calendar_id).toBe('new-calendar@group.calendar.google.com')
  })
  it('refuses a reply without a matching, unexpired, signed state, before asking Google anything', async () => {
    const cases = [
      [{ code: 'CODE', state: goodState }, {}],
      [{ code: 'CODE', state: goodState }, { cookie: 'vm_calendar_state=someone-else' }],
      [{ code: 'CODE', state: makeState('WRONG', nonce, NOW + 60_000) }, { cookie }],
      [{ code: 'CODE', state: makeState(env.GOOGLE_CLIENT_SECRET, nonce, NOW - 1) }, { cookie }],
      [{ code: 'CODE', state: 'garbage' }, { cookie }],
    ]
    for (const [query, headers] of cases) {
      const database = fakeDatabase()
      const google = fakeGoogle()
      const response = await back(query, headers, { database, google })
      expect(response.headers.location).toBe('/admin/settings/google-calendar?calendar=expired')
      expect(google.calls).toEqual([])
      expect(database.rpcs).toEqual([])
    }
  })
  it('says the sign-in was cancelled, or that access was not given, and keeps nothing', async () => {
    expect((await back({ error: 'access_denied', state: goodState })).headers.location).toBe('/admin/settings/google-calendar?calendar=cancelled')
    for (const token of [{ access_token: 'ACCESS', id_token: idToken, scope: SCOPES }, { access_token: 'ACCESS', refresh_token: 'NEW-REFRESH', scope: 'openid email' }]) {
      const database = fakeDatabase()
      expect((await back({ code: 'CODE', state: goodState }, { cookie }, { database, google: fakeGoogle({ token }) })).headers.location).toBe('/admin/settings/google-calendar?calendar=no-access')
      expect(database.rpcs).toEqual([])
    }
    expect((await back({ code: 'CODE', state: goodState }, { cookie }, { google: fakeGoogle({ tokenStatus: 400, token: { error: 'invalid_grant' } }) })).headers.location).toBe('/admin/settings/google-calendar?calendar=error')
  })
})

describe('disconnecting', () => {
  it('withdraws the sign-in at Google and forgets it here, for the Admin only', async () => {
    const database = fakeDatabase()
    const google = fakeGoogle()
    expect((await call({ method: 'POST', url: '/api/google-calendar?action=disconnect', headers: { authorization: 'Bearer client-jwt' }, database, google })).statusCode).toBe(401)
    expect(database.rpcs).toEqual([])
    const response = await call({ method: 'POST', url: '/api/google-calendar?action=disconnect', headers: { authorization: 'Bearer admin-jwt' }, database, google })
    expect(response.statusCode).toBe(200)
    expect(google.calls).toEqual([['POST', 'https://oauth2.googleapis.com/revoke', 'token=OLD-REFRESH']])
    expect(database.rpcs).toEqual([['calendar_refresh_token', undefined], ['calendar_forget_connection', { p_status: 'disconnected' }]])
    expect(response.body).not.toMatch(secrets)
  })
})
