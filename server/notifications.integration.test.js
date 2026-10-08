import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { localConfig } from '../tests/localSupabase.js'
import { createDispatcher, readConfig } from './notifications.js'

const env = { APP_BASE_URL: 'https://booking.example.com', TELEGRAM_BOT_TOKEN: 'tg-token', ADMIN_TELEGRAM_CHAT_ID: '1', RESEND_API_KEY: 'resend-key', EMAIL_FROM: 'Vad <hello@example.com>', ADMIN_ALERT_EMAIL: 'vad@example.com' }
let admin, ids
beforeEach(async () => {
  const config = localConfig()
  admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const area = (await admin.from('service_areas').select('id,name').eq('slug', 'chelsea').single()).data
  const client = (await admin.from('clients').insert({ first_name: 'Sender', last_name: 'Test', email: `sender-${crypto.randomUUID()}@example.test` }).select().single()).data
  const booking = (await admin.from('bookings').insert({ client_id: client.id, service_area_id: area.id, date: '2031-06-02', start_minutes: 600, treatment_duration_minutes: 60, booking_status: 'confirmed',
    source_channel: 'web', address_line_1_snapshot: '1 Test Road', city_snapshot: 'London', postcode_snapshot: 'SW1A1AA', service_area_name_snapshot: area.name, service_subtotal_gbp: 85, total_gbp: 85,
    booking_email_snapshot: client.email, booking_reference: `SEND-${crypto.randomUUID()}` }).select().single()).data
  ids = { client: client.id, booking: booking.id, email: client.email }
})
afterEach(async () => {
  await admin.from('event_outbox').delete().eq('aggregate_id', ids.booking)
  await admin.from('bookings').delete().eq('id', ids.booking)
  await admin.from('clients').delete().eq('id', ids.client)
})

async function emit(type, payload = {}) {
  const { data, error } = await admin.from('event_outbox').insert({ event_type: type, aggregate_type: 'booking', aggregate_id: ids.booking, payload }).select().single()
  expect(error).toBeNull()
  return data
}
const deliveries = async event => (await admin.from('notification_deliveries').select('channel,audience,status,attempt_count,last_error,next_attempt_at').eq('event_id', event.id).order('channel')).data

describe('the sender against local Supabase', () => {
  it('sends the Telegram and email rows for a client booking, and leaves the in-app row alone', async () => {
    const event = await emit('booking.transfer_declared', { method: 'bank_transfer' })
    const sent = []
    const result = await createDispatcher({ client: admin, config: readConfig(env), fetchImpl: async url => { sent.push(url); return { ok: true, status: 200, json: async () => ({ ok: true }) } } }).dispatch({ limit: 50 })
    expect(result.sent).toBeGreaterThanOrEqual(2)
    expect(sent.some(url => url.includes('api.telegram.org'))).toBe(true)
    expect(sent.some(url => url.includes('api.resend.com'))).toBe(true)
    const rows = await deliveries(event)
    expect(rows.map(row => [row.channel, row.status])).toEqual([['email', 'sent'], ['in_app', 'sent'], ['telegram', 'sent']])
    expect(rows.find(row => row.channel === 'in_app').attempt_count).toBe(0)
  })

  it('emails the client at the address on the booking when the Admin confirms it', async () => {
    const event = await emit('booking.bank_transfer_verified')
    const bodies = []
    await createDispatcher({ client: admin, config: readConfig(env), fetchImpl: async (url, init) => { if (url.includes('resend')) bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({}) } } }).dispatch({ limit: 50 })
    const mine = bodies.find(body => body.to[0] === ids.email)
    expect(mine).toMatchObject({ subject: 'Your appointment is confirmed' })
    expect(mine.text).toContain('https://booking.example.com/account?booking=' + ids.booking)
    expect(mine.text).toContain('I have received your payment.')
    expect((await deliveries(event))[0]).toMatchObject({ status: 'sent' })
  })

  it('records a failure with a retry time, then does not resend until it is due', async () => {
    const event = await emit('booking.cash_requested', { method: 'cash' })
    const failing = async () => ({ ok: false, status: 502, json: async () => ({ ok: false, description: 'Bad Gateway' }) })
    await createDispatcher({ client: admin, config: readConfig({ ...env, RESEND_API_KEY: '' }), fetchImpl: failing }).dispatch({ limit: 50 })
    const telegram = (await deliveries(event)).find(row => row.channel === 'telegram')
    expect(telegram).toMatchObject({ status: 'failed', attempt_count: 1, last_error: 'Telegram: Bad Gateway' })
    expect(Date.parse(telegram.next_attempt_at)).toBeGreaterThan(Date.now() + 60000)
    let calls = 0
    await createDispatcher({ client: admin, config: readConfig({ ...env, RESEND_API_KEY: '' }), fetchImpl: async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ ok: true }) } } }).dispatch({ limit: 50 })
    expect((await deliveries(event)).find(row => row.channel === 'telegram').status).toBe('failed')
    expect(calls).toBe(0)
  })

  it('cannot be run by a signed-in user', async () => {
    const config = localConfig()
    const anon = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false } })
    const attempt = await anon.rpc('claim_notification_deliveries', { p_limit: 5, p_channels: ['telegram'] })
    expect(attempt.error).toBeTruthy()
  })
})
