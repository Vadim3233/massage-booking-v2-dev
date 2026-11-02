import { describe, expect, it } from 'vitest'
import { handle } from '../api/dispatch-notifications.js'
import { composeMessage, createDispatcher, enabledChannels, readConfig } from './notifications.js'

const env = { APP_BASE_URL: 'https://booking.example.com/', TELEGRAM_BOT_TOKEN: '123:SECRET-TOKEN', ADMIN_TELEGRAM_CHAT_ID: '555', RESEND_API_KEY: 're_SECRET_KEY',
  EMAIL_FROM: 'Vad <hello@example.com>', ADMIN_ALERT_EMAIL: 'vad@example.com', EMAIL_REPLY_TO: 'vad@example.com' }
const row = (overrides = {}) => ({ id: 'd1', channel: 'telegram', audience: 'admin', recipient: 'admin', title: 'New booking request', body: 'Nadia: Mon 5 May at 14:30.', link_path: '/admin/bookings/b1', ...overrides })

function fakeClient(rows, failRepeats = false, failReminders = false, mint = null) {
  const completed = []
  const stopped = []
  const minted = []
  return { completed, stopped, minted, async rpc(name, args) {
    if (name === 'mint_booking_access_token') { minted.push(args); if (!mint) throw new Error('unexpected mint_booking_access_token'); return mint(args.p_booking_id, minted.length) }
    if (name === 'claim_notification_deliveries') { this.claimArgs = args; return { data: rows.filter(r => args.p_channels.includes(r.channel)), error: null } }
    if (name === 'complete_notification_delivery') { completed.push(args); return { error: null } }
    if (name === 'stop_client_telegram') { stopped.push(args); return { data: 1, error: null } }
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

describe('the clients-only Telegram bot', () => {
  const clientEnv = { ...env, TELEGRAM_CLIENT_BOT_TOKEN: '777:CLIENT-BOT-TOKEN' }
  const message = (overrides = {}) => row({ id: 'k1', channel: 'telegram_client', audience: 'client', recipient: '424242', title: 'Your appointment is confirmed',
    body: 'Thank you. Your appointment is confirmed for Mon 5 May at 14:30.\n\nTo change or cancel, use the link in your email, or contact Vad.', link_path: null, ...overrides })
  it('is switched on by its own token only, and the Admin channels do not depend on it', () => {
    expect(enabledChannels(readConfig(clientEnv))).toEqual(['telegram', 'telegram_client', 'email'])
    expect(enabledChannels(readConfig({ ...clientEnv, TELEGRAM_BOT_TOKEN: '', ADMIN_TELEGRAM_CHAT_ID: '' }))).toEqual(['telegram_client', 'email'])
    expect(enabledChannels(readConfig(env))).not.toContain('telegram_client')
    expect(enabledChannels(readConfig({ TELEGRAM_CLIENT_BOT_TOKEN: '777:x' }))).toEqual(['telegram_client'])
  })
  it('has its token trimmed, and never accepts the Admin bot as the clients-only bot', () => {
    expect(readConfig({ ...env, TELEGRAM_CLIENT_BOT_TOKEN: '  777:CLIENT-BOT-TOKEN \n' }).telegramClient.token).toBe('777:CLIENT-BOT-TOKEN')
    const same = readConfig({ ...env, TELEGRAM_CLIENT_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN })
    expect(same.telegramClient.token).toBe('')
    expect(enabledChannels(same)).not.toContain('telegram_client')
    expect(readConfig({ ...env, TELEGRAM_CLIENT_BOT_TOKEN: `${env.TELEGRAM_BOT_TOKEN}\n` }).telegramClient.token).toBe('')
  })
  it('does not wait for ever for Telegram: the call is cut off after a few seconds', async () => {
    const signals = []
    await createDispatcher({ client: fakeClient([message()]), config: readConfig(clientEnv), fetchImpl: async (url, init) => { signals.push(init.signal); return okResponse({ ok: true }) } }).dispatch()
    expect(signals).toHaveLength(1)
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect(signals[0].aborted).toBe(false)
  })
  it('sends to the chat the client linked, with the clients-only bot, and records success', async () => {
    const calls = []
    const client = fakeClient([message()])
    const result = await createDispatcher({ client, config: readConfig(clientEnv), fetchImpl: async (url, init) => { calls.push([url, JSON.parse(init.body)]); return okResponse({ ok: true }) } }).dispatch()
    expect(result).toMatchObject({ claimed: 1, sent: 1, failed: 0 })
    expect(client.claimArgs.p_channels).toContain('telegram_client')
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('https://api.telegram.org/bot777:CLIENT-BOT-TOKEN/sendMessage')
    expect(calls[0][1]).toEqual({ chat_id: 424242, text: 'Your appointment is confirmed\n\nThank you. Your appointment is confirmed for Mon 5 May at 14:30.\n\nTo change or cancel, use the link in your email, or contact Vad.', disable_web_page_preview: true })
    expect(client.completed).toEqual([{ p_id: 'k1', p_ok: true, p_error: null }])
  })
  it('never sends a client message to the Admin chat, or with the Admin bot', async () => {
    const calls = []
    await createDispatcher({ client: fakeClient([message(), message({ id: 'k2', recipient: '99' })]), config: readConfig(clientEnv), fetchImpl: async (url, init) => { calls.push([url, JSON.parse(init.body)]); return okResponse({ ok: true }) } }).dispatch()
    expect(calls.map(([url]) => url).every(url => url.includes('777:CLIENT-BOT-TOKEN'))).toBe(true)
    expect(calls.map(([, body]) => body.chat_id)).toEqual([424242, 99])
    expect(JSON.stringify(calls)).not.toContain('123:SECRET-TOKEN')
    expect(calls.map(([, body]) => body.chat_id)).not.toContain(555)
  })
  it('keeps the two audiences apart even if a row is on the wrong channel', async () => {
    const calls = []
    // (The database refuses an Admin row on the client channel, so this is a second line of defence: even one that gets there with a real chat
    // number as its recipient is not sent.)
    const client = fakeClient([row({ id: 'wrong1', channel: 'telegram', audience: 'client', recipient: '424242' }), message({ id: 'wrong2', audience: 'admin', recipient: 'admin' }),
      message({ id: 'wrong3', audience: 'admin', recipient: '424242' })])
    const result = await createDispatcher({ client, config: readConfig(clientEnv), fetchImpl: async (url, init) => { calls.push([url, JSON.parse(init.body)]); return okResponse({ ok: true }) } }).dispatch()
    expect(calls).toEqual([])
    expect(result).toMatchObject({ claimed: 3, sent: 0, failed: 3 })
    expect(client.completed.map(item => item.p_ok)).toEqual([false, false, false])
  })
  it('will not send to something that is not a chat', async () => {
    const calls = []
    const client = fakeClient([message({ recipient: 'not-a-number' })])
    const result = await createDispatcher({ client, config: readConfig(clientEnv), fetchImpl: async () => { calls.push(1); return okResponse({ ok: true }) } }).dispatch()
    expect(calls).toEqual([])
    expect(result).toMatchObject({ sent: 0, failed: 1 })
  })
  it('ends the link of a chat that has blocked the bot or is gone, and records why, without the token', async () => {
    for (const [code, description] of [[403, 'Forbidden: bot was blocked by the user'], [400, 'Bad Request: chat not found']]) {
      const client = fakeClient([message()])
      const result = await createDispatcher({ client, config: readConfig(clientEnv), fetchImpl: async () => ({ ok: false, status: code, json: async () => ({ ok: false, error_code: code, description }) }) }).dispatch()
      expect(result).toMatchObject({ sent: 0, failed: 1 })
      expect(client.stopped).toEqual([{ p_chat_id: 424242 }])
      expect(client.completed[0]).toEqual({ p_id: 'k1', p_ok: false, p_error: `Telegram: ${description}` })
    }
  })
  it('leaves the link alone for an ordinary failure, and scrubs the token out of network errors', async () => {
    const refused = fakeClient([message()])
    await createDispatcher({ client: refused, config: readConfig(clientEnv), fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ ok: false, error_code: 429, description: 'Too Many Requests: retry later' }) }) }).dispatch()
    expect(refused.stopped).toEqual([])
    expect(refused.completed[0].p_error).toBe('Telegram: Too Many Requests: retry later')
    // A message Telegram will not take for another reason (too long, say) is not a reason to end the link either.
    const tooLong = fakeClient([message()])
    await createDispatcher({ client: tooLong, config: readConfig(clientEnv), fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: message is too long' }) }) }).dispatch()
    expect(tooLong.stopped).toEqual([])
    expect(tooLong.completed[0].p_error).toBe('Telegram: Bad Request: message is too long')
    const down = fakeClient([message()])
    await createDispatcher({ client: down, config: readConfig(clientEnv), fetchImpl: async url => { throw new Error(`connect ECONNRESET ${url}`) } }).dispatch()
    expect(down.completed[0].p_error).not.toContain('CLIENT-BOT-TOKEN')
    expect(down.completed[0].p_error).toContain('[hidden]')
    expect(down.stopped).toEqual([])
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
  it('gives every Admin alert and email a time limit, and each email a key so a repeated send is not sent twice', async () => {
    const calls = []
    const client = fakeClient([row(), row({ id: 'e1', channel: 'email' })])
    await createDispatcher({ client, config: readConfig(env), fetchImpl: async (url, init) => { calls.push([url, init]); return okResponse({ ok: true, id: 'x' }) } }).dispatch()
    expect(calls).toHaveLength(2)
    for (const [, init] of calls) expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(calls[1][1].headers['idempotency-key']).toBe('delivery-e1')
  })
  it('counts an email as sent when Resend says the key was already used for an earlier try, but tries again while one is in progress', async () => {
    const reply = body => ({ ok: false, status: 409, json: async () => body })
    const used = fakeClient([row({ id: 'e2', channel: 'email' })])
    await createDispatcher({ client: used, config: readConfig(env), fetchImpl: async () => reply({ name: 'invalid_idempotent_request', message: 'Same idempotency key used with a different request payload.' }) }).dispatch()
    expect(used.completed).toEqual([{ p_id: 'e2', p_ok: true, p_error: null }])
    const busy = fakeClient([row({ id: 'e3', channel: 'email' })])
    await createDispatcher({ client: busy, config: readConfig(env), fetchImpl: async () => reply({ name: 'concurrent_idempotent_requests', message: 'Same idempotency key used while original request is still in progress.' }) }).dispatch()
    expect(busy.completed[0]).toMatchObject({ p_id: 'e3', p_ok: false })
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
  it('puts the same private link on the button of the HTML version, which the plain text keeps beside it, and gives the Admin plain text only', async () => {
    const { calls } = await send([clientRow(), row({ id: 'a', channel: 'email' })])
    expect(calls[0].html).toContain('href="https://booking.example.com/account?booking=b1#key=CODE1-b1"')
    expect(calls[0].html).not.toContain('{link}')
    expect(calls[0].text).toBe('Thank you.\n\nSee or change your booking: https://booking.example.com/account?booking=b1#key=CODE1-b1')
    expect(calls[1].html).toBeUndefined()
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
    // A client's Telegram message goes out on the clients-only channel, with that bot's own token (the Admin's bot refuses client messages).
    const telegram = await send([clientRow({ id: 't', channel: 'telegram_client', recipient: '424242' })], mint, undefined, readConfig({ ...env, TELEGRAM_CLIENT_BOT_TOKEN: '777:CLIENT-BOT-TOKEN' }))
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
