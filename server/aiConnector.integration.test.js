import { createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { localFixture } from '../tests/localSupabase.js'
import { unwrap } from '../src/client/booking/bookingApi.js'
import { handleMcp } from './aiConnector/mcp.js'

// The whole road an AI assistant takes, against local Supabase with its OAuth server switched on (supabase/config.toml): it registers itself,
// the client allows it on the consent page, it swaps the code for a token, and then books a couple's massage through /mcp as that client.
const REDIRECT = 'http://127.0.0.1:9/callback'
let fixture, token, oauthClientId
const base64url = buffer => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function signInAsAssistant() {
  const auth = `${fixture.config.API_URL}/auth/v1`
  const registered = await (await fetch(`${auth}/oauth/clients/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test assistant', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })).json()
  oauthClientId = registered.client_id
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const query = new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'openid email' })
  const toConsent = await fetch(`${auth}/oauth/authorize?${query}`, { redirect: 'manual' })
  const consent = new URL(toConsent.headers.get('location'))
  expect(consent.pathname).toBe('/oauth/consent')
  const authorizationId = consent.searchParams.get('authorization_id')
  // What the consent page does when the signed-in client presses Allow.
  const details = await unwrap(fixture.client.auth.oauth.getAuthorizationDetails(authorizationId))
  expect(details.client.name).toBe('Test assistant')
  const approved = await unwrap(fixture.client.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true }))
  const back = new URL(approved.redirect_url)
  expect(back.searchParams.get('state')).toBe('xyz')
  const tokens = await (await fetch(`${auth}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: REDIRECT, client_id: registered.client_id, code_verifier: verifier }) })).json()
  expect(tokens.access_token).toBeTruthy()
  return tokens.access_token
}

let id = 0
async function mcp(method, params, bearer = token) {
  const response = { statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value }, end(body = '') { this.body = body } }
  const env = { SUPABASE_URL: fixture.config.API_URL, SUPABASE_ANON_KEY: fixture.config.ANON_KEY, TELEGRAM_CLIENT_BOT_USERNAME: 'VadTestBot' }
  await handleMcp({ method: 'POST', headers: { host: 'book.example.test', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: { jsonrpc: '2.0', id: ++id, method, params } }, response, { env })
  return { status: response.statusCode, headers: response.headers, body: response.body ? JSON.parse(response.body) : null }
}
const call = async (name, args = {}) => {
  const { body } = await mcp('tools/call', { name, arguments: args })
  if (body.result.isError) throw new Error(body.result.content[0].text)
  return body.result.structuredContent
}

beforeAll(async () => {
  fixture = await localFixture(21)
  await unwrap(fixture.admin.from('client_addresses').insert({ client_id: fixture.profile.client_id, label: 'Home', address: '10 Test Street, London, SW1A 1AA', is_default: true }))
  token = await signInAsAssistant()
}, 60000)
afterAll(async () => {
  if (fixture) {
    await fixture.admin.from('ai_request_counts').delete().eq('user_id', (await fixture.client.auth.getUser()).data.user.id)
    await fixture.admin.from('client_addresses').delete().eq('client_id', fixture.profile.client_id)
    await fixture.cleanup()
  }
}, 60000)

describe('booking through an AI assistant, end to end', () => {
  it('sends an assistant with no token to sign in', async () => {
    const result = await mcp('initialize', {}, null)
    expect(result.status).toBe(401)
    expect(result.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource/mcp')
  })
  it('lists the tools once signed in', async () => {
    expect((await mcp('initialize', { protocolVersion: '2025-06-18' })).body.result.serverInfo.name).toBe('vad-massage-booking')
    expect((await mcp('tools/list')).body.result.tools.map(tool => tool.name)).toContain('book_appointment')
  })
  it('books a couple at the saved address, marked as made by an AI assistant, and only once', async () => {
    const options = await call('get_my_booking_options')
    const treatment = options.treatments.find(item => item.treatment_id === fixture.ids.service)
    const home = options.saved_addresses[0]
    const areaId = home.area_id || fixture.ids.area
    const free = await call('find_free_times', { lengths: [60, 60], from_date: fixture.date })
    const time = free.days[0].times[0]
    const price = await call('get_price', { treatment_id: treatment.treatment_id, lengths: [60, 60], address_id: home.address_id, area_id: areaId })
    expect(price.expected_total_gbp).toBe(190)
    const request = { treatment_id: treatment.treatment_id, lengths: [60, 60], address_id: home.address_id, area_id: areaId, date: fixture.date, time, payment_method: 'bank_transfer', expected_total_gbp: 190, second_person_name: 'Sam', client_confirmed: true }
    const booked = await call('book_appointment', request)
    expect(booked).toMatchObject({ booked: true, booking: { start: time, total: '£190' }, payment: { method: 'bank_transfer', amount: '£190' } })
    expect(booked.telegram.link).toMatch(/^https:\/\/t\.me\/VadTestBot\?start=/)
    const stored = await unwrap(fixture.admin.from('bookings').select('id,source_channel,address_snapshot,booking_sessions(recipient_name,duration_minutes)').eq('client_id', fixture.profile.client_id))
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ source_channel: 'ai_assistant', address_snapshot: '10 Test Street, London, SW1A 1AA' })
    expect(stored[0].booking_sessions.map(session => session.recipient_name).sort()).toEqual(['Guest 1', 'Sam'])
    // Asked again, nothing new is made.
    expect((await call('book_appointment', request)).already_booked).toBe(true)
    expect(await unwrap(fixture.admin.from('bookings').select('id').eq('client_id', fixture.profile.client_id))).toHaveLength(1)
    // "I've paid", the list and the calendar.
    expect((await call('i_have_paid', { booking_reference: booked.booking.reference })).booking.payment).toBe('Transfer sent, Vadim is checking it')
    expect((await call('list_my_bookings')).upcoming.map(item => item.reference)).toEqual([booked.booking.reference])
    expect((await call('add_to_calendar', { booking_reference: booked.booking.reference })).ics_file).toContain(`UID:${stored[0].id}@vadmassage.com`)
  }, 60000)
  it('leaves a booking made with the app\'s own sign-in as an online booking', async () => {
    const { data } = await fixture.client.auth.getSession()
    expect(JSON.parse(Buffer.from(data.session.access_token.split('.')[1], 'base64url').toString()).client_id).toBeUndefined()
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    expect(claims.client_id).toBe(oauthClientId)
  })
  it('stops an assistant that asks too often', async () => {
    const user = (await fixture.client.auth.getUser()).data.user.id
    await unwrap(fixture.admin.from('ai_request_counts').update({ requests: 120 }).eq('user_id', user))
    const { body } = await mcp('tools/call', { name: 'list_my_bookings', arguments: {} })
    expect(body.result).toMatchObject({ isError: true, content: [{ text: 'Your assistant has asked too many times in the last hour. Please try again later, or book in the app.' }] })
  })
})
