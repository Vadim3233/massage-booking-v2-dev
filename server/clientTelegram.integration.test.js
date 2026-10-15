import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handle } from '../api/telegram-webhook.js'
import { unwrap } from '../src/client/booking/bookingApi.js'
import { createTelegramApi } from '../src/client/booking/telegramApi.js'
import { localFixture } from '../tests/localSupabase.js'
import { createDispatcher, readConfig } from './notifications.js'
import { createWebhookHandler, linkedMessage } from './telegramWebhook.js'

let f
beforeEach(async () => { f = await localFixture(33) }, 30000)
afterEach(async () => { await f?.cleanup() }, 30000)

const SECRET = 'a-long-secret-for-the-integration-test'
const BOT = '55:CLIENTBOT-INTEGRATION'
const okTelegram = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
const privateMessage = (chat, text) => ({ message: { chat: { id: chat, type: 'private' }, text } })
// A chat number nobody has: Telegram's real ones are far larger or negative for groups.
const newChat = () => 700000000 + Math.floor(Math.random() * 90000000)

async function booking() {
  const row = await unwrap(f.admin.from('bookings').insert({
    client_id: f.profile.client_id, service_area_id: f.ids.area, date: f.date, start_minutes: 600, treatment_duration_minutes: 60, booking_status: 'confirmed',
    source_channel: 'web', address_line_1_snapshot: '1 Test Road', city_snapshot: 'London', postcode_snapshot: 'SW1A1AA', service_area_name_snapshot: 'Integration area',
    service_subtotal_gbp: 85, total_gbp: 85, booking_email_snapshot: f.email, booking_reference: `TGI-${crypto.randomUUID()}` }).select().single())
  await unwrap(f.admin.from('booking_sessions').insert({ booking_id: row.id, position: 1, service_id: f.ids.service, duration_minutes: 60, service_name_snapshot: 'Integration massage', unit_price_gbp: 85 }))
  await unwrap(f.admin.from('booking_payments').insert({ booking_id: row.id, method: 'cash', status: 'approved', amount_gbp: 85 }))
  return row
}
// Something happens to the booking (the Admin moves it): the database writes the client's email, and copies it to any linked chat.
const move = id => unwrap(f.admin.from('event_outbox').insert({ event_type: 'booking.rescheduled', aggregate_type: 'booking', aggregate_id: id, deduplication_key: `tg-int-${crypto.randomUUID()}`,
  payload: { booking_id: id, initiated_by: 'admin', source: 'admin' } }))
const deliveriesFor = id => unwrap(f.admin.from('notification_deliveries').select('id,channel,audience,recipient,title,body,status,attempt_count,event_outbox!inner(aggregate_id)').eq('event_outbox.aggregate_id', id))

describe('a client getting booking updates on Telegram, against local Supabase', () => {
  it('links a chat with a one-time code, copies the booking emails to it, sends them with the clients-only bot, and stops on /stop', async () => {
    const api = createTelegramApi(f.client)
    const chat = newChat()
    const webhook = createWebhookHandler({ client: f.admin, token: BOT, fetchImpl: okTelegram })
    expect(await api.status()).toBe(false)
    const code = await api.createLink()
    expect(code).toMatch(/^[0-9a-f]{32}$/)
    // Pressing Start in Telegram links the chat, once.
    const replies = []
    const talk = createWebhookHandler({ client: f.admin, token: BOT, fetchImpl: async (url, init) => { replies.push(JSON.parse(init.body)); return okTelegram() } })
    expect(await talk(privateMessage(chat, `/start ${code}`))).toEqual({ handled: true, status: 'linked' })
    expect(replies).toEqual([{ chat_id: chat, text: linkedMessage('Test'), disable_web_page_preview: true }])
    expect(await api.status()).toBe(true)
    // The same code from another chat is refused: it was used up.
    expect(await talk(privateMessage(newChat(), `/start ${code}`))).toEqual({ handled: true, status: 'used' })
    // Something happens to a booking: the client is emailed, and the same words go to the chat.
    const row = await booking()
    await move(row.id)
    const rows = await deliveriesFor(row.id)
    expect(rows.map(item => `${item.channel}:${item.audience}`).sort()).toEqual(['email:client', 'telegram_client:client'])
    const copy = rows.find(item => item.channel === 'telegram_client')
    expect(copy).toMatchObject({ recipient: String(chat), title: 'Your appointment has moved', status: 'pending' })
    expect(copy.body).toContain('Your appointment is now on')
    expect(copy.body).not.toContain('{link}')
    expect(copy.body).not.toContain('Warm wishes')
    // The sender sends it, to that chat, with the clients-only bot, and records it as sent.
    const calls = []
    const result = await createDispatcher({ client: f.admin, config: readConfig({ TELEGRAM_CLIENT_BOT_TOKEN: BOT }),
      fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return okTelegram() } }).dispatch({ limit: 50 })
    expect(result).toMatchObject({ sent: 1, failed: 0, channels: ['telegram_client'] })
    expect(calls).toEqual([{ url: `https://api.telegram.org/bot${BOT}/sendMessage`, body: { chat_id: chat, text: `${copy.title}\n\n${copy.body}`, disable_web_page_preview: true } }])
    expect((await deliveriesFor(row.id)).find(item => item.id === copy.id).status).toBe('sent')
    // /stop ends it: nothing more is copied.
    expect(await talk(privateMessage(chat, '/stop'))).toEqual({ handled: true, status: 'stopped' })
    expect(await api.status()).toBe(false)
    await move(row.id)
    expect((await deliveriesFor(row.id)).filter(item => item.channel === 'telegram_client')).toHaveLength(1)
    expect(await webhook(privateMessage(chat, '/stop'))).toEqual({ handled: true, status: 'notStarted' })
  })

  it('drops what is still waiting for a chat when /stop comes, so the next sender run sends nothing to it', async () => {
    const api = createTelegramApi(f.client)
    const chat = newChat()
    const talk = createWebhookHandler({ client: f.admin, token: BOT, fetchImpl: okTelegram })
    await talk(privateMessage(chat, `/start ${await api.createLink()}`))
    const row = await booking()
    await move(row.id)
    expect((await deliveriesFor(row.id)).filter(item => item.channel === 'telegram_client')).toMatchObject([{ status: 'pending', attempt_count: 0 }])
    // The client sends /stop before the sender has run.
    expect(await talk(privateMessage(chat, '/stop'))).toEqual({ handled: true, status: 'stopped' })
    const calls = []
    const result = await createDispatcher({ client: f.admin, config: readConfig({ TELEGRAM_CLIENT_BOT_TOKEN: BOT }),
      fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body)); return okTelegram() } }).dispatch({ limit: 50 })
    expect(result).toMatchObject({ claimed: 0, sent: 0, failed: 0 })
    expect(calls).toEqual([])
    expect((await deliveriesFor(row.id)).filter(item => item.channel === 'telegram_client')).toMatchObject([{ status: 'failed', attempt_count: 5 }])
    // The email to the client was not touched.
    expect((await deliveriesFor(row.id)).find(item => item.channel === 'email')).toMatchObject({ status: 'pending' })
  })

  it('a chat that has blocked the bot ends its link, and the rest of what is waiting for it is dropped, not tried again and again', async () => {
    const api = createTelegramApi(f.client)
    const chat = newChat()
    const talk = createWebhookHandler({ client: f.admin, token: BOT, fetchImpl: okTelegram })
    await talk(privateMessage(chat, `/start ${await api.createLink()}`))
    const row = await booking()
    await move(row.id)
    await move(row.id)
    expect((await deliveriesFor(row.id)).filter(item => item.channel === 'telegram_client')).toHaveLength(2)
    // Telegram says the client has blocked the bot: the one message tried fails, the link ends, and the other is dropped.
    const blocked = async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }) })
    const result = await createDispatcher({ client: f.admin, config: readConfig({ TELEGRAM_CLIENT_BOT_TOKEN: BOT }), fetchImpl: blocked }).dispatch({ limit: 1 })
    expect(result).toMatchObject({ claimed: 1, sent: 0, failed: 1 })
    expect(await api.status()).toBe(false)
    const copies = (await deliveriesFor(row.id)).filter(item => item.channel === 'telegram_client')
    expect(copies.map(item => [item.status, item.attempt_count]).sort()).toEqual([['failed', 1], ['failed', 5]])
  })

  it('never links a chat to another client, and a client cannot link or stop anything themselves', async () => {
    const code = await createTelegramApi(f.client).createLink()
    // Only the service key can link or stop a chat: not the client, and not a visitor.
    for (const client of [f.client, f.publicClient]) {
      expect((await client.rpc('link_client_telegram', { p_token: code, p_chat_id: newChat() })).error).toBeTruthy()
      expect((await client.rpc('stop_client_telegram', { p_chat_id: newChat() })).error).toBeTruthy()
    }
    expect(await createTelegramApi(f.client).status()).toBe(false)
    // A visitor with no session cannot ask for a code, or for the state of one.
    await expect(createTelegramApi(f.publicClient).createLink()).rejects.toBeDefined()
    await expect(createTelegramApi(f.publicClient).status()).rejects.toBeDefined()
    // The tables cannot be read by anyone but the service key, not even by the client they are about.
    for (const table of ['client_telegram_tokens', 'client_telegram_links']) {
      expect((await f.client.from(table).select('id')).error).toBeTruthy()
      expect((await f.publicClient.from(table).select('id')).error).toBeTruthy()
      expect((await f.admin.from(table).select('id')).error).toBeNull()
    }
  })

  it('answers Telegram through the endpoint only with the right secret, and links the chat for a real call', async () => {
    const chat = newChat()
    const code = await createTelegramApi(f.client).createLink()
    const sent = []
    const env = { TELEGRAM_CLIENT_BOT_TOKEN: BOT, TELEGRAM_WEBHOOK_SECRET: SECRET, SUPABASE_URL: f.config.API_URL, SUPABASE_SERVICE_ROLE_KEY: f.config.SERVICE_ROLE_KEY }
    const reply = () => { const out = { headers: {}, statusCode: 0, body: '' }; return { out, setHeader: (k, v) => { out.headers[k] = v }, set statusCode(v) { out.statusCode = v }, get statusCode() { return out.statusCode }, end: text => { out.body = text } } }
    const call = async (headers, body) => { const response = reply(); await handle({ method: 'POST', headers, body }, response, { env, createServiceClient: () => f.admin, fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body)); return okTelegram() } }); return response.out }
    const wrong = await call({ 'x-telegram-bot-api-secret-token': 'wrong' }, privateMessage(chat, `/start ${code}`))
    expect(wrong.statusCode).toBe(401)
    expect(await createTelegramApi(f.client).status()).toBe(false)
    const right = await call({ 'x-telegram-bot-api-secret-token': SECRET }, privateMessage(chat, `/start ${code}`))
    expect(right.statusCode).toBe(200)
    expect(await createTelegramApi(f.client).status()).toBe(true)
    expect(sent).toEqual([{ chat_id: chat, text: linkedMessage('Test'), disable_web_page_preview: true }])
  })
})
