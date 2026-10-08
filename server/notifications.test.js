import { describe, expect, it } from 'vitest'
import { handle } from '../api/dispatch-notifications.js'
import { composeMessage, createDispatcher, enabledChannels, readConfig } from './notifications.js'

const env = { APP_BASE_URL: 'https://booking.example.com/', TELEGRAM_BOT_TOKEN: '123:SECRET-TOKEN', ADMIN_TELEGRAM_CHAT_ID: '555', RESEND_API_KEY: 're_SECRET_KEY',
  EMAIL_FROM: 'Vad <hello@example.com>', ADMIN_ALERT_EMAIL: 'vad@example.com', EMAIL_REPLY_TO: 'vad@example.com' }
const row = (overrides = {}) => ({ id: 'd1', channel: 'telegram', audience: 'admin', recipient: 'admin', title: 'New booking request', body: 'Nadia: Mon 5 May at 14:30.', link_path: '/admin/bookings/b1', ...overrides })

function fakeClient(rows, failRepeats = false) {
  const completed = []
  return { completed, async rpc(name, args) {
    if (name === 'claim_notification_deliveries') { this.claimArgs = args; return { data: rows.filter(r => args.p_channels.includes(r.channel)), error: null } }
    if (name === 'complete_notification_delivery') { completed.push(args); return { error: null } }
    if (name === 'run_series_maintenance') return failRepeats ? { data: null, error: { message: 'boom' } } : { data: { made: 2, clashes: 0, ended: 0 }, error: null }
    throw new Error(`unexpected ${name}`)
  } }
}
const okResponse = body => ({ ok: true, status: 200, json: async () => body })

describe('configuration', () => {
  it('turns on only the channels that are fully set up', () => {
    expect(enabledChannels(readConfig(env))).toEqual(['telegram', 'email'])
    expect(enabledChannels(readConfig({ ...env, TELEGRAM_BOT_TOKEN: '' }))).toEqual(['email'])
    expect(enabledChannels(readConfig({ ...env, EMAIL_FROM: '' }))).toEqual(['telegram'])
    expect(enabledChannels(readConfig({}))).toEqual([])
  })
})

describe('writing the message', () => {
  const config = readConfig(env)
  it('adds a link to the exact booking for the Admin', () => {
    expect(composeMessage(row(), config)).toMatchObject({ url: 'https://booking.example.com/admin/bookings/b1', body: 'Nadia: Mon 5 May at 14:30.\n\nOpen the booking: https://booking.example.com/admin/bookings/b1' })
  })
  it('puts the link where the client message asks for it', () => {
    const message = composeMessage(row({ audience: 'client', body: 'Hello.\n\nSee or change your booking: {link}\n\nWarm wishes,\nVad', link_path: '/account?booking=b1' }), config)
    expect(message.body).toBe('Hello.\n\nSee or change your booking: https://booking.example.com/account?booking=b1\n\nWarm wishes,\nVad')
  })
  it('drops the link line, tidily, when no public address is configured', () => {
    const message = composeMessage(row({ audience: 'client', body: 'Hello.\n\nSee or change your booking: {link}\n\nWarm wishes,\nVad', link_path: '/account' }), readConfig({}))
    expect(message.body).toBe('Hello.\n\nWarm wishes,\nVad')
    expect(message.url).toBe('')
  })
})

describe('sending', () => {
  it('sends a Telegram alert with a button, and records success', async () => {
    const calls = []
    const client = fakeClient([row()])
    const result = await createDispatcher({ client, config: readConfig(env), fetchImpl: async (url, init) => { calls.push([url, JSON.parse(init.body)]); return okResponse({ ok: true }) } }).dispatch()
    expect(result).toMatchObject({ claimed: 1, sent: 1, failed: 0 })
    expect(calls[0][0]).toBe('https://api.telegram.org/bot123:SECRET-TOKEN/sendMessage')
    expect(calls[0][1]).toMatchObject({ chat_id: '555', text: expect.stringContaining('New booking request'), reply_markup: { inline_keyboard: [[{ text: 'Open booking', url: 'https://booking.example.com/admin/bookings/b1' }]] } })
    expect(client.completed).toEqual([{ p_id: 'd1', p_ok: true, p_error: null }])
  })
  it('leaves the button off when the link is not https, because Telegram would refuse it', async () => {
    const calls = []
    await createDispatcher({ client: fakeClient([row()]), config: readConfig({ ...env, APP_BASE_URL: 'http://localhost:5174' }), fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body)); return okResponse({ ok: true }) } }).dispatch()
    expect(calls[0].reply_markup).toBeUndefined()
  })
  it('emails the Admin at the configured address and the client at their own', async () => {
    const calls = []
    const client = fakeClient([row({ id: 'a', channel: 'email' }), row({ id: 'c', channel: 'email', audience: 'client', recipient: 'nadia@example.com', title: 'Your appointment is confirmed', body: 'Thank you.\n\nSee or change your booking: {link}', link_path: '/account?booking=b1' })])
    await createDispatcher({ client, config: readConfig(env), fetchImpl: async (url, init) => { calls.push([url, init.headers.authorization, JSON.parse(init.body)]); return okResponse({ id: 'x' }) } }).dispatch()
    expect(calls[0][2]).toMatchObject({ to: ['vad@example.com'], subject: '[VadMassage] New booking request' })
    expect(calls[0][2].reply_to).toBeUndefined()
    expect(calls[1][2]).toMatchObject({ to: ['nadia@example.com'], subject: 'Your appointment is confirmed', reply_to: 'vad@example.com', from: 'Vad <hello@example.com>' })
    expect(calls[1][2].text).toContain('https://booking.example.com/account?booking=b1')
    expect(calls[1][1]).toBe('Bearer re_SECRET_KEY')
  })
  it('only claims the channels that are configured', async () => {
    const client = fakeClient([row(), row({ id: 'e', channel: 'email' })])
    const result = await createDispatcher({ client, config: readConfig({ ...env, RESEND_API_KEY: '' }), fetchImpl: async () => okResponse({ ok: true }) }).dispatch()
    expect(client.claimArgs.p_channels).toEqual(['telegram'])
    expect(result.claimed).toBe(1)
    const none = await createDispatcher({ client: fakeClient([row()]), config: readConfig({}) }).dispatch()
    expect(none).toEqual({ claimed: 0, sent: 0, failed: 0, channels: [] })
  })
})

describe('when sending fails', () => {
  it('records Telegram refusing the message, without exposing the token', async () => {
    const client = fakeClient([row()])
    const result = await createDispatcher({ client, config: readConfig(env), fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ ok: false, description: 'Bad Request: chat not found' }) }) }).dispatch()
    expect(result).toMatchObject({ sent: 0, failed: 1 })
    expect(client.completed[0]).toEqual({ p_id: 'd1', p_ok: false, p_error: 'Telegram: Bad Request: chat not found' })
  })
  it('scrubs secrets out of network errors', async () => {
    const client = fakeClient([row()])
    await createDispatcher({ client, config: readConfig(env), fetchImpl: async url => { throw new Error(`connect ECONNRESET ${url}`) } }).dispatch()
    expect(client.completed[0].p_error).not.toContain('SECRET-TOKEN')
    expect(client.completed[0].p_error).toContain('[hidden]')
  })
  it('records Resend errors by their message', async () => {
    const client = fakeClient([row({ channel: 'email' })])
    await createDispatcher({ client, config: readConfig(env), fetchImpl: async () => ({ ok: false, status: 422, json: async () => ({ message: 'The from address is not verified' }) }) }).dispatch()
    expect(client.completed[0]).toEqual({ p_id: 'd1', p_ok: false, p_error: 'Email: The from address is not verified' })
  })
  it('explains a missing Admin email address instead of failing silently', async () => {
    const client = fakeClient([row({ channel: 'email' })])
    await createDispatcher({ client, config: readConfig({ ...env, ADMIN_ALERT_EMAIL: '' }), fetchImpl: async () => okResponse({}) }).dispatch()
    expect(client.completed[0].p_error).toBe('ADMIN_ALERT_EMAIL is not set')
  })
  it('keeps going after one failure and reports honestly', async () => {
    const client = fakeClient([row({ id: 'a' }), row({ id: 'b' })])
    let call = 0
    const result = await createDispatcher({ client, config: readConfig(env), fetchImpl: async () => (++call === 1 ? { ok: false, status: 500, json: async () => ({}) } : okResponse({ ok: true })) }).dispatch()
    expect(result).toMatchObject({ claimed: 2, sent: 1, failed: 1 })
  })
})

describe('the endpoint', () => {
  const reply = () => { const out = { headers: {}, statusCode: 0, body: '' }; return { out, setHeader: (k, v) => { out.headers[k] = v }, set statusCode(v) { out.statusCode = v }, get statusCode() { return out.statusCode }, end: text => { out.body = text } } }
  const request = (overrides = {}) => ({ method: 'GET', headers: { authorization: 'Bearer cron-secret' }, ...overrides })
  const deps = { env: { ...env, CRON_SECRET: 'cron-secret', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'service-key' }, createServiceClient: () => fakeClient([row()]), fetchImpl: async () => okResponse({ ok: true }) }
  it('refuses callers without the secret', async () => {
    for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: 'cron-secret' }]) {
      const response = reply(); await handle(request({ headers }), response, deps)
      expect(response.out.statusCode).toBe(401)
    }
  })
  it('refuses everything while no secret is configured', async () => {
    const response = reply(); await handle(request(), response, { ...deps, env: { ...deps.env, CRON_SECRET: '' } })
    expect(response.out.statusCode).toBe(401)
  })
  it('refuses other methods', async () => {
    const response = reply(); await handle(request({ method: 'DELETE' }), response, deps)
    expect(response.out.statusCode).toBe(405)
  })
  it('runs for the right caller and returns only counts', async () => {
    const response = reply(); await handle(request(), response, deps)
    expect(response.out.statusCode).toBe(200)
    expect(JSON.parse(response.out.body)).toEqual({ claimed: 1, sent: 1, failed: 0, channels: ['telegram', 'email'], repeats: { made: 2, clashes: 0, ended: 0 } })
    expect(response.out.body).not.toMatch(/SECRET|service-key/)
  })
  it('still sends messages when the repeating-bookings job fails, without saying why', async () => {
    const response = reply(); await handle(request(), response, { ...deps, createServiceClient: () => fakeClient([row()], true) })
    expect(response.out.statusCode).toBe(200)
    expect(JSON.parse(response.out.body)).toMatchObject({ sent: 1, repeats: { failed: true } })
    expect(response.out.body).not.toMatch(/boom/)
  })
  it('does not reveal why it could not run', async () => {
    const response = reply()
    await handle(request(), response, { ...deps, createServiceClient: () => { throw new Error('database password is hunter2') } })
    expect(response.out.statusCode).toBe(500)
    expect(response.out.body).toBe('{"error":"The sender could not run"}')
    const unconfigured = reply()
    await handle(request(), unconfigured, { ...deps, env: { ...deps.env, SUPABASE_SERVICE_ROLE_KEY: '' } })
    expect(unconfigured.out.statusCode).toBe(500)
  })
})
