import { describe, expect, it } from 'vitest'
import { handle } from '../api/telegram-webhook.js'
import { CALL_LIMIT_MS, createWebhookHandler, linkedMessage, MESSAGES, parseCommand, readTelegramConfig, secretMatches } from './telegramWebhook.js'

const TOKEN = '987:CLIENT-BOT-SECRET'
const env = { TELEGRAM_CLIENT_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: 'a-long-secret-the-owner-made-up', SUPABASE_URL: 'http://localhost', SUPABASE_SERVICE_ROLE_KEY: 'service-key' }
const privateMessage = (text, chat = 555) => ({ update_id: 1, message: { message_id: 1, chat: { id: chat, type: 'private' }, text } })

// A database that answers what it is told to, and a Telegram that records what it is asked to send.
function fakes({ link = { status: 'linked' }, stopped = 1, rpcError = null, failReply = false } = {}) {
  const rpcs = []
  const sent = []
  const client = { async rpc(name, args) { rpcs.push([name, args]); if (rpcError) return { data: null, error: rpcError }; return { data: name === 'link_client_telegram' ? link : stopped, error: null } } }
  const fetchImpl = async (url, init) => { if (failReply) throw new Error(`network down ${url}`); sent.push({ url, body: JSON.parse(init.body), signal: init.signal }); return { ok: true, status: 200 } }
  return { client, fetchImpl, rpcs, sent }
}

describe('reading what a person sent', () => {
  it('understands /start, /start with a code, and /stop', () => {
    expect(parseCommand('/start')).toEqual({ name: 'start', code: '' })
    expect(parseCommand('/start abc123_-XYZ')).toEqual({ name: 'start', code: 'abc123_-XYZ' })
    expect(parseCommand('  /START   code1  ')).toEqual({ name: 'start', code: 'code1' })
    expect(parseCommand('/start@VadMassageBot code1')).toEqual({ name: 'start', code: 'code1' })
    expect(parseCommand('/stop')).toEqual({ name: 'stop', code: '' })
    expect(parseCommand('/stop@VadMassageBot')).toEqual({ name: 'stop', code: '' })
  })
  it('reads nothing else as a command, and refuses a code with odd characters or too long', () => {
    for (const text of ['hello', 'start', '/help', '/start two codes', '/start a;b', `/start ${'a'.repeat(65)}`, '/startx', '/stop now', '', null, undefined, 42]) expect(parseCommand(text)).toBeNull()
  })
})

describe('the secret Telegram sends', () => {
  it('matches only the exact secret', () => {
    expect(secretMatches('abc', 'abc')).toBe(true)
    for (const given of ['abd', 'ab', 'abcd', '', undefined, null, 5, ['abc']]) expect(secretMatches(given, 'abc')).toBe(false)
    expect(secretMatches('abc', '')).toBe(false)
    expect(secretMatches('', '')).toBe(false)
  })
  it('is read from the environment', () => {
    expect(readTelegramConfig(env)).toEqual({ token: TOKEN, secret: env.TELEGRAM_WEBHOOK_SECRET })
    expect(readTelegramConfig({})).toEqual({ token: '', secret: '' })
  })
  it('is trimmed, because a stray space or line break is easy to paste into a settings page', () => {
    expect(readTelegramConfig({ TELEGRAM_CLIENT_BOT_TOKEN: `  ${TOKEN}\n`, TELEGRAM_WEBHOOK_SECRET: `${env.TELEGRAM_WEBHOOK_SECRET}\r\n` }))
      .toEqual({ token: TOKEN, secret: env.TELEGRAM_WEBHOOK_SECRET })
  })
  it("is not accepted when the secret is too short to be a secret, or the token is the Admin bot's", () => {
    expect(readTelegramConfig({ ...env, TELEGRAM_WEBHOOK_SECRET: 'short-secret' })).toEqual({ token: TOKEN, secret: '' })
    expect(readTelegramConfig({ ...env, TELEGRAM_WEBHOOK_SECRET: 'x'.repeat(15) }).secret).toBe('')
    expect(readTelegramConfig({ ...env, TELEGRAM_WEBHOOK_SECRET: 'x'.repeat(16) }).secret).toBe('x'.repeat(16))
    expect(readTelegramConfig({ ...env, TELEGRAM_BOT_TOKEN: TOKEN })).toEqual({ token: '', secret: env.TELEGRAM_WEBHOOK_SECRET })
    expect(readTelegramConfig({ ...env, TELEGRAM_BOT_TOKEN: `${TOKEN}\n` }).token).toBe('')
    expect(readTelegramConfig({ ...env, TELEGRAM_BOT_TOKEN: '111:ADMIN-BOT' }).token).toBe(TOKEN)
  })
})

describe('saying whose appointments the chat is connected to', () => {
  it('names the client by first name, and says how to stop if that is not them', () => {
    const text = linkedMessage('Nia')
    expect(text).toContain("You're connected, Nia.")
    expect(text).toContain('If you are not Nia')
    expect(text).toContain('/stop')
  })
  it('keeps a name to one short line, however it was written', () => {
    expect(linkedMessage('  Nia\n  Lee  ')).toContain("You're connected, Nia Lee.")
    const long = linkedMessage('y'.repeat(100))
    expect(long).toContain(`You're connected, ${'y'.repeat(40)}.`)
    expect(long).not.toContain('y'.repeat(41))
    expect(linkedMessage('a\r\nb\t\tc')).toContain("You're connected, a b c.")
  })
  it('falls back to the plain answer when there is no name', () => {
    for (const none of ['', '   ', null, undefined, 42, {}]) expect(linkedMessage(none)).toBe(MESSAGES.linked)
  })
})

describe('what the bot does with a message', () => {
  const run = async (text, options, chat) => {
    const f = fakes(options)
    const result = await createWebhookHandler({ client: f.client, token: TOKEN, fetchImpl: f.fetchImpl })(privateMessage(text, chat))
    return { ...f, result }
  }
  it('links the chat when a client presses Start with their code, and says so', async () => {
    const { rpcs, sent, result } = await run('/start 0123456789abcdef0123456789abcdef')
    expect(rpcs).toEqual([['link_client_telegram', { p_token: '0123456789abcdef0123456789abcdef', p_chat_id: 555 }]])
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`)
    expect(sent[0].body).toMatchObject({ chat_id: 555, text: MESSAGES.linked })
    expect(result).toEqual({ handled: true, status: 'linked' })
  })
  it('says whose appointments the chat is connected to, when the database gives a name', async () => {
    const { sent, result } = await run('/start 0123456789abcdef0123456789abcdef', { link: { status: 'linked', first_name: 'Nia' } })
    expect(sent[0].body.text).toBe(linkedMessage('Nia'))
    expect(result).toEqual({ handled: true, status: 'linked' })
    // A name is only ever used in the answer for a chat that was linked.
    const used = await run('/start 0123456789abcdef0123456789abcdef', { link: { status: 'used', first_name: 'Nia' } })
    expect(used.sent[0].body.text).toBe(MESSAGES.used)
  })
  it('works for a chat number beyond 2^31 (Telegram numbers are large)', async () => {
    const { rpcs, sent } = await run('/start 0123456789abcdef0123456789abcdef', {}, 5000000001)
    expect(rpcs[0][1]).toEqual({ p_token: '0123456789abcdef0123456789abcdef', p_chat_id: 5000000001 })
    expect(sent[0].body.chat_id).toBe(5000000001)
  })
  it('does not wait for ever for Telegram when it answers: the call is cut off after a few seconds', async () => {
    const { sent } = await run('/start')
    expect(CALL_LIMIT_MS).toBeGreaterThanOrEqual(1000)
    expect(CALL_LIMIT_MS).toBeLessThanOrEqual(10000)
    expect(sent[0].signal).toBeInstanceOf(AbortSignal)
    expect(sent[0].signal.aborted).toBe(false)
  })
  it('says something kind and plain for a code that was used, has lapsed or is not one', async () => {
    for (const status of ['used', 'expired', 'invalid']) {
      const { sent, result } = await run('/start abcdefghijklmnop', { link: { status } })
      expect(sent[0].body.text).toBe(MESSAGES[status])
      expect(result.status).toBe(status)
    }
    // An answer it does not know is treated as a code that cannot be used, never shown as it came.
    const odd = await run('/start abcdefghijklmnop', { link: { status: 'toString' } })
    expect(odd.sent[0].body.text).toBe(MESSAGES.invalid)
    const empty = await run('/start abcdefghijklmnop', { link: null })
    expect(empty.sent[0].body.text).toBe(MESSAGES.invalid)
  })
  it('greets someone who presses Start without a code, and does not touch the database', async () => {
    const { rpcs, sent } = await run('/start')
    expect(rpcs).toEqual([])
    expect(sent[0].body.text).toBe(MESSAGES.hello)
  })
  it('stops the updates on /stop, and says so only if there was something to stop', async () => {
    const stopped = await run('/stop', { stopped: 2 })
    expect(stopped.rpcs).toEqual([['stop_client_telegram', { p_chat_id: 555 }]])
    expect(stopped.sent[0].body.text).toBe(MESSAGES.stopped)
    const none = await run('/stop', { stopped: 0 })
    expect(none.sent[0].body.text).toBe(MESSAGES.notStarted)
  })
  it('answers anything else with where to change or cancel, and does nothing else', async () => {
    const { rpcs, sent, result } = await run('Can I move my booking to Friday?')
    expect(rpcs).toEqual([])
    expect(sent[0].body.text).toBe(MESSAGES.help)
    expect(result.status).toBe('help')
  })
  it('does not fail because an answer could not be delivered, once the work is done', async () => {
    const { rpcs, result } = await run('/start 0123456789abcdef', { failReply: true })
    expect(rpcs).toHaveLength(1)
    expect(result.status).toBe('linked')
  })
  it('fails (so Telegram tries again) when the database could not do its part', async () => {
    const f = fakes({ rpcError: { message: 'boom' } })
    const handler = createWebhookHandler({ client: f.client, token: TOKEN, fetchImpl: f.fetchImpl })
    await expect(handler(privateMessage('/start 0123456789abcdef'))).rejects.toThrow('Could not link the chat')
    await expect(handler(privateMessage('/stop'))).rejects.toThrow('Could not stop the chat')
    expect(f.sent).toEqual([])
  })
  it('ignores groups, channels, edits and anything that is not text, without a word', async () => {
    const f = fakes()
    const handler = createWebhookHandler({ client: f.client, token: TOKEN, fetchImpl: f.fetchImpl })
    const updates = [
      { message: { chat: { id: -100, type: 'group' }, text: '/start 0123456789abcdef' } },
      { message: { chat: { id: -200, type: 'supergroup' }, text: '/stop' } },
      { message: { chat: { id: -300, type: 'channel' }, text: 'hi' } },
      { edited_message: { chat: { id: 5, type: 'private' }, text: '/stop' } },
      { message: { chat: { id: 5, type: 'private' }, photo: [] } },
      { message: { chat: { id: 'five', type: 'private' }, text: '/stop' } },
      { message: { chat: { id: 1.5, type: 'private' }, text: '/stop' } },
      { message: { chat: { type: 'private' }, text: '/stop' } },
      { message: null }, {}, null, undefined, 'text',
    ]
    for (const update of updates) expect(await handler(update)).toEqual({ handled: false })
    expect(f.rpcs).toEqual([])
    expect(f.sent).toEqual([])
  })
})

describe('the endpoint', () => {
  const reply = () => { const out = { headers: {}, statusCode: 0, body: '' }; return { out, setHeader: (k, v) => { out.headers[k] = v }, set statusCode(v) { out.statusCode = v }, get statusCode() { return out.statusCode }, end: text => { out.body = text } } }
  const request = (overrides = {}) => ({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET }, body: privateMessage('/start 0123456789abcdef'), ...overrides })
  const run = async (req, options = {}) => {
    const f = fakes(options.fakes)
    const response = reply()
    await handle(req, response, { env: options.env || env, createServiceClient: () => f.client, fetchImpl: f.fetchImpl })
    return { ...f, response }
  }
  it('refuses a call without the secret, or with a wrong one, before reading anything', async () => {
    for (const headers of [{}, { 'x-telegram-bot-api-secret-token': 'nope' }, { 'x-telegram-bot-api-secret-token': '' }, { authorization: `Bearer ${env.TELEGRAM_WEBHOOK_SECRET}` }]) {
      const { response, rpcs, sent } = await run(request({ headers }))
      expect(response.out.statusCode).toBe(401)
      expect(rpcs).toEqual([])
      expect(sent).toEqual([])
    }
  })
  it('accepts only POST', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) expect((await run(request({ method }))).response.out.statusCode).toBe(405)
  })
  it('says it is not set up, rather than doing anything, when a setting is missing', async () => {
    for (const missing of ['TELEGRAM_CLIENT_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'SUPABASE_SERVICE_ROLE_KEY']) {
      const { response, rpcs } = await run(request(), { env: { ...env, [missing]: '' } })
      expect(response.out.statusCode).toBe(500)
      expect(response.out.body).not.toContain(missing)
      expect(rpcs).toEqual([])
    }
  })
  it('does the work for a call with the secret, and answers ok', async () => {
    const { response, rpcs, sent } = await run(request())
    expect(response.out.statusCode).toBe(200)
    expect(JSON.parse(response.out.body)).toEqual({ ok: true })
    expect(response.out.headers['cache-control']).toBe('no-store')
    expect(rpcs).toHaveLength(1)
    expect(sent[0].body.text).toBe(MESSAGES.linked)
  })
  it('reads a body that arrived as text, and answers ok to one that is nothing to read', async () => {
    const asText = await run(request({ body: JSON.stringify(privateMessage('/stop')) }))
    expect(asText.response.out.statusCode).toBe(200)
    expect(asText.rpcs).toEqual([['stop_client_telegram', { p_chat_id: 555 }]])
    for (const body of ['{not json', '', undefined, null, 42]) {
      const nothing = await run(request({ body }))
      expect(nothing.response.out.statusCode).toBe(200)
      expect(nothing.rpcs).toEqual([])
    }
  })
  it('answers with an error, and nothing about it, when our side failed, so that Telegram tries again', async () => {
    const { response } = await run(request(), { fakes: { rpcError: { message: `secret detail ${TOKEN}` } } })
    expect(response.out.statusCode).toBe(500)
    expect(response.out.body).toBe(JSON.stringify({ error: 'The bot could not process that' }))
    expect(response.out.body).not.toContain(TOKEN)
  })
})
