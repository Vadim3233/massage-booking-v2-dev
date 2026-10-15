import { describe, expect, it } from 'vitest'
import { handle } from '../api/dispatch-notifications.js'
import { composeMessage, createDispatcher, enabledChannels, readConfig } from './notifications.js'

const env = { APP_BASE_URL: 'https://booking.example.com/', TELEGRAM_BOT_TOKEN: '123:SECRET-TOKEN', ADMIN_TELEGRAM_CHAT_ID: '555', RESEND_API_KEY: 're_SECRET_KEY',
  EMAIL_FROM: 'Vad <hello@example.com>', ADMIN_ALERT_EMAIL: 'vad@example.com', EMAIL_REPLY_TO: 'vad@example.com' }
const row = (overrides = {}) => ({ id: 'd1', channel: 'telegram', audience: 'admin', recipient: 'admin', title: 'New booking request', body: 'Nadia: Mon 5 May at 14:30.', link_path: '/admin/bookings/b1', ...overrides })

function fakeClient(rows, failRepeats = false, failReminders = false, mint = null) {
  const completed = []
  const minted = []
  return { completed, minted, async rpc(name, args) {
    if (name === 'mint_booking_access_token') { minted.push(args); if (!mint) throw new Error('unexpected mint_booking_access_token'); return mint(args.p_booking_id, minted.length) }
    if (name === 'claim_notification_deliveries') { this.claimArgs = args; return { data: rows.filter(r => args.p_channels.includes(r.channel)), error: null } }
    if (name === 'complete_notification_delivery') { completed.push(args); return { error: null } }
    if (name === 'run_series_maintenance') return failRepeats ? { data: null, error: { message: 'boom' } } : { data: { made: 2, clashes: 0, ended: 0 }, error: null }
    if (name === 'plan_day_of_reminders') return failReminders ? { data: null, error: { message: 'boom' } } : { data: 2, error: null }
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

describe('the private link in a client\'s email', () => {
  const clientRow = (overrides = {}) => row({ id: 'c', channel: 'email', audience: 'client', recipient: 'nadia@example.com', title: 'Your appointment is confirmed', body: 'Thank you.\n\nSee or change your booking: {link}', link_path: '/account?booking=b1', ...overrides })
  const mint = (booking, count) => ({ data: `CODE${count}-${booking}`, error: null })
  const send = async (rows, minting = mint, fetchImpl, config = readConfig(env)) => {
    const calls = []
    const client = fakeClient(rows, false, false, minting)
    await createDispatcher({ client, config, fetchImpl: fetchImpl || (async (url, init) => { calls.push(JSON.parse(init.body)); return okResponse({ id: 'x', ok: true }) }) }).dispatch()
    return { client, calls }
  }
  it('makes a code for the booking just before the email goes, and puts it after the # so no server ever sees it', async () => {
    const { client, calls } = await send([clientRow()])
    expect(client.minted).toEqual([{ p_booking_id: 'b1' }])
    expect(calls[0].text).toContain('See or change your booking: https://booking.example.com/account?booking=b1#key=CODE1-b1')
    expect(client.completed).toEqual([{ p_id: 'c', p_ok: true, p_error: null }])
  })
  it('gives every email its own code', async () => {
    const { client, calls } = await send([clientRow({ id: 'c1' }), clientRow({ id: 'c2' })])
    expect(client.minted).toHaveLength(2)
    expect(calls[0].text).toContain('#key=CODE1-b1')
    expect(calls[1].text).toContain('#key=CODE2-b1')
  })
  it('sends the plain link instead, and still sends, when a code cannot be made', async () => {
    for (const minting of [() => ({ data: null, error: { message: 'boom' } }), () => ({ data: '', error: null }), () => ({ data: { not: 'text' }, error: null }), () => { throw new Error('network down') }]) {
      const { client, calls } = await send([clientRow()], minting)
      expect(calls[0].text.endsWith('See or change your booking: https://booking.example.com/account?booking=b1')).toBe(true)
      expect(calls[0].text).not.toContain('#key')
      expect(client.completed).toEqual([{ p_id: 'c', p_ok: true, p_error: null }])
    }
  })
  it('makes no code for the Admin, or for a link that is not to a booking', async () => {
    const { client, calls } = await send([row({ id: 'a', channel: 'email' }), row({ id: 't' }), clientRow({ id: 'x', link_path: '/account' }), clientRow({ id: 'y', link_path: '/account?booking=' }),
      row({ id: 'z', channel: 'email', audience: 'admin', link_path: '/account?booking=b1' })])
    expect(client.minted).toEqual([])
    expect(calls.every(call => !JSON.stringify(call).includes('#key'))).toBe(true)
  })
  it('makes no code for a client message that is not an email, or where there is no public address to put the link on', async () => {
    const telegram = await send([clientRow({ id: 't', channel: 'telegram' })])
    expect(telegram.client.minted).toEqual([])
    expect(telegram.calls.length).toBe(1)
    expect(JSON.stringify(telegram.calls)).not.toContain('#key')
    const noAddress = await send([clientRow()], mint, undefined, readConfig({ ...env, APP_BASE_URL: '' }))
    expect(noAddress.client.minted).toEqual([])
    expect(noAddress.calls[0].text).not.toContain('#key')
  })
  it('never lets the code into a recorded failure, even if the provider repeats it back', async () => {
    const { client } = await send([clientRow()], mint, async () => ({ ok: false, status: 422, json: async () => ({ message: 'Invalid link https://booking.example.com/account?booking=b1#key=CODE1-b1 in the body' }) }))
    expect(client.completed[0].p_ok).toBe(false)
    expect(client.completed[0].p_error).toContain('[hidden]')
    expect(client.completed[0].p_error).not.toContain('CODE1-b1')
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
    expect(JSON.parse(response.out.body)).toEqual({ claimed: 1, sent: 1, failed: 0, channels: ['telegram', 'email'], repeats: { made: 2, clashes: 0, ended: 0 }, reminders: { made: 2 } })
    expect(response.out.body).not.toMatch(/SECRET|service-key/)
  })
  it('still sends messages when the repeating-bookings job fails, without saying why', async () => {
    const response = reply(); await handle(request(), response, { ...deps, createServiceClient: () => fakeClient([row()], true) })
    expect(response.out.statusCode).toBe(200)
    expect(JSON.parse(response.out.body)).toMatchObject({ sent: 1, repeats: { failed: true } })
    expect(response.out.body).not.toMatch(/boom/)
  })
  it('still sends messages when the reminders step fails, without saying why', async () => {
    const response = reply(); await handle(request(), response, { ...deps, createServiceClient: () => fakeClient([row()], false, true) })
    expect(response.out.statusCode).toBe(200)
    expect(JSON.parse(response.out.body)).toMatchObject({ sent: 1, reminders: { failed: true }, repeats: { made: 2 } })
    expect(response.out.body).not.toMatch(/boom/)
  })
  it('plans the morning reminders before it sends, so they go out in the same run', async () => {
    const order = []
    const client = fakeClient([row()])
    const original = client.rpc.bind(client)
    client.rpc = async (name, args) => { order.push(name); return original(name, args) }
    const response = reply(); await handle(request(), response, { ...deps, createServiceClient: () => client })
    expect(order).toContain('plan_day_of_reminders')
    expect(order.indexOf('plan_day_of_reminders')).toBeLessThan(order.indexOf('claim_notification_deliveries'))
  })
  describe('a long queue', () => {
    // A queue that hands out the next rows each time it is asked, as the real one does.
    const queueClient = (count) => {
      const queue = Array.from({ length: count }, (_, index) => row({ id: `d${index}` }))
      const claims = []
      const client = { queue, claims, completed: [], async rpc(name, args) {
        if (name === 'claim_notification_deliveries') { claims.push(args.p_limit); return { data: queue.splice(0, args.p_limit), error: null } }
        if (name === 'complete_notification_delivery') { client.completed.push(args); return { error: null } }
        return { data: name === 'plan_day_of_reminders' ? 0 : { made: 0, clashes: 0, ended: 0 }, error: null }
      } }
      return client
    }
    it('is sent over several rounds, ten at a time, and stops when it runs dry', async () => {
      const client = queueClient(25)
      const response = reply(); await handle(request(), response, { ...deps, createServiceClient: () => client })
      expect(JSON.parse(response.out.body)).toMatchObject({ claimed: 25, sent: 25, failed: 0 })
      expect(client.claims).toEqual([10, 10, 10])
    })
    it('is sent for five rounds at most in one run, and the rest waits for the next', async () => {
      const client = queueClient(70)
      const response = reply(); await handle(request(), response, { ...deps, createServiceClient: () => client })
      expect(JSON.parse(response.out.body)).toMatchObject({ claimed: 50, sent: 50 })
      expect(client.claims).toHaveLength(5)
      expect(client.queue).toHaveLength(20)
    })
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
