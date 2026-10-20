import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { localConfig } from '../tests/localSupabase.js'
import { handle } from '../api/dispatch-notifications.js'
import { createCalendarSync, readCalendarConfig } from './calendarSync.js'

// The calendar copy against local Supabase, with a stand-in for Google that keeps events in memory the way Google does (a deleted event is
// remembered as cancelled, so putting it in again with the same id is refused with 409).
const config = readCalendarConfig({ GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret' })
const CALENDAR = 'test-calendar@group.calendar.google.com'
let admin, ids, google

function fakeGoogle() {
  const events = new Map()
  const calls = []
  const state = { tokenError: null, failNext: null }
  const reply = (status, body = {}) => ({ ok: status < 300, status, json: async () => body })
  async function fetchImpl(url, init = {}) {
    if (url === 'https://oauth2.googleapis.com/token') {
      calls.push(['TOKEN'])
      if (state.tokenError) return reply(400, { error: state.tokenError })
      return reply(200, { access_token: 'access-token', expires_in: 3599 })
    }
    const path = url.replace('https://www.googleapis.com/calendar/v3', '')
    calls.push([init.method, decodeURIComponent(path)])
    if (state.failNext) { const status = state.failNext; state.failNext = null; return reply(status, { error: { errors: [{ reason: 'backendError' }] } }) }
    const match = path.match(/^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/)
    if (!match || decodeURIComponent(match[1]) !== CALENDAR) return reply(404, { error: { errors: [{ reason: 'notFound' }] } })
    const id = match[2] && decodeURIComponent(match[2])
    const body = init.body ? JSON.parse(init.body) : null
    if (init.method === 'POST') {
      if (events.has(body.id)) return reply(409, { error: { errors: [{ reason: 'duplicate' }] } })
      events.set(body.id, body); return reply(200, body)
    }
    if (init.method === 'PUT') {
      if (!events.has(id)) return reply(404, { error: { errors: [{ reason: 'notFound' }] } })
      events.set(id, body); return reply(200, body)
    }
    if (init.method === 'DELETE') {
      const event = events.get(id)
      if (!event) return reply(404)
      if (event.status === 'cancelled') return reply(410)
      events.set(id, { ...event, status: 'cancelled' }); return reply(204)
    }
    return reply(400)
  }
  const live = () => [...events.values()].filter(event => event.status !== 'cancelled' && ids.bookings.includes(event.extendedProperties?.private?.bookingId))
  return { events, calls, state, fetchImpl, live }
}

// Other test files add bookings to the shared local database at the same time: the queue is trimmed to this test's bookings just before each run.
const sync = (options = {}) => {
  const job = createCalendarSync({ client: admin, config, fetchImpl: google.fetchImpl, ...options })
  return { run: async (...args) => { await keepOnlyMine(); return job.run(...args) } }
}
const queueRow = async id => (await admin.from('calendar_sync_queue').select('*').eq('booking_id', id).maybeSingle()).data
// Only this test's bookings are worked on: the shared local database has other tests' bookings too.
async function keepOnlyMine() { await admin.from('calendar_sync_queue').delete().not('booking_id', 'in', `(${ids.bookings.join(',')})`) }

beforeAll(async () => {
  const local = localConfig()
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
})
beforeEach(async () => {
  google = fakeGoogle()
  const area = (await admin.from('service_areas').select('id,name').eq('slug', 'chelsea').single()).data
  const service = (await admin.from('services').select('id').order('created_at').limit(1).single()).data
  const client = (await admin.from('clients').insert({ first_name: 'Calendar', last_name: 'Copy', email: `calendar-${crypto.randomUUID()}@example.test`, phone: '+447700900321' }).select().single()).data
  const booking = (await admin.from('bookings').insert({ client_id: client.id, service_area_id: area.id, date: '2031-06-02', start_minutes: 600, treatment_duration_minutes: 60, booking_status: 'confirmed',
    source_channel: 'web', address_snapshot: '7 Private Lane, London, SW1A 1AA', service_area_name_snapshot: area.name, service_subtotal_gbp: 85, total_gbp: 85, client_note: 'Secret note',
    booking_email_snapshot: client.email, booking_reference: `CAL-${crypto.randomUUID()}` }).select().single()).data
  await admin.from('booking_sessions').insert({ booking_id: booking.id, position: 1, service_id: service.id, duration_minutes: 60, service_name_snapshot: 'Deep tissue', unit_price_gbp: 85 })
  ids = { client: client.id, booking: booking.id, bookings: [booking.id] }
  await admin.from('calendar_connection').delete().eq('id', true)
  const { error } = await admin.rpc('calendar_save_connection', { p_refresh_token: 'refresh-token', p_account_email: 'owner@example.test', p_calendar_id: CALENDAR })
  expect(error).toBeNull()
  // The 15-minute and nightly checks are tested on their own; here they are not due.
  await admin.from('calendar_connection').update({ last_check_at: new Date().toISOString(), last_full_check_at: new Date().toISOString() }).eq('id', true)
  await keepOnlyMine()
})
afterEach(async () => {
  await admin.rpc('calendar_forget_connection', { p_status: 'disconnected' })
  await admin.from('calendar_connection').delete().eq('id', true)
  await admin.from('calendar_sync_events').delete().in('booking_id', ids.bookings)
  await admin.from('calendar_sync_queue').delete().in('booking_id', ids.bookings)
  await admin.from('event_outbox').delete().in('aggregate_id', ids.bookings)
  await admin.from('bookings').delete().in('id', ids.bookings)
  await admin.from('clients').delete().eq('id', ids.client)
  await admin.from('calendar_sync_queue').delete().in('booking_id', ids.bookings)
})
afterAll(async () => { await admin.from('calendar_connection').delete().eq('id', true) })

describe('the Google Calendar copy against local Supabase', () => {
  it('puts a new booking in as one booking event and one travel event, and says nothing private', async () => {
    const summary = await sync().run()
    expect(summary).toMatchObject({ synced: 1, failed: 0 })
    const [booking, travel] = google.live().sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime))
    expect(booking).toMatchObject({ summary: 'Massage – Calendar Copy', description: 'Deep tissue 60 min · 60 min total', transparency: 'opaque', status: 'confirmed',
      start: { dateTime: '2031-06-02T09:00:00.000Z', timeZone: 'Europe/London' }, end: { dateTime: '2031-06-02T10:00:00.000Z', timeZone: 'Europe/London' },
      extendedProperties: { private: { bookingId: ids.booking, kind: 'booking' } } })
    expect(travel).toMatchObject({ summary: 'Travel', start: { dateTime: '2031-06-02T10:00:00.000Z' }, end: { dateTime: '2031-06-02T11:00:00.000Z' }, reminders: { useDefault: false } })
    expect(travel).not.toHaveProperty('description')
    const sent = JSON.stringify(google.live())
    for (const secret of ['Private Lane', 'SW1A', 'Secret note', '85', '07700', '447700', '@example.test', 'CAL-']) expect(sent).not.toContain(secret)
    expect(await queueRow(ids.booking)).toBeNull()
    const connection = (await admin.from('calendar_connection').select('last_success_at,last_error').single()).data
    expect(connection.last_success_at).not.toBeNull()
    expect(connection.last_error).toBeNull()
  })

  it('the same booking checked again makes no second event and calls Google for nothing', async () => {
    await sync().run()
    await admin.rpc('queue_calendar_sync', { p_booking_ids: [ids.booking] })
    google.calls.length = 0
    expect(await sync().run()).toMatchObject({ synced: 1 })
    expect(google.calls.filter(([method]) => method !== 'TOKEN')).toEqual([])
    expect(google.live()).toHaveLength(2)
  })

  it('a move and a new name change the events; a cancellation removes both, and checking again is fine', async () => {
    await sync().run()
    await admin.from('bookings').update({ start_minutes: 780 }).eq('id', ids.booking)
    await admin.from('clients').update({ first_name: 'Renamed' }).eq('id', ids.client)
    await keepOnlyMine()
    await sync().run()
    const booking = google.live().find(event => event.extendedProperties.private.kind === 'booking')
    expect(booking).toMatchObject({ summary: 'Massage – Renamed Copy', start: { dateTime: '2031-06-02T12:00:00.000Z' } })
    await admin.from('bookings').update({ booking_status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', ids.booking)
    await keepOnlyMine()
    expect(await sync().run()).toMatchObject({ synced: 1, failed: 0 })
    expect(google.live()).toEqual([])
    expect((await admin.from('calendar_sync_events').select('kind').eq('booking_id', ids.booking)).data).toEqual([])
    await admin.rpc('queue_calendar_sync', { p_booking_ids: [ids.booking] })
    expect(await sync().run()).toMatchObject({ synced: 1, failed: 0 })
  })

  it('an event deleted in Google (or whose record was lost) is brought back, not refused', async () => {
    await sync().run()
    for (const [id, event] of google.events) google.events.set(id, { ...event, status: 'cancelled' })
    await admin.from('calendar_sync_events').delete().eq('booking_id', ids.booking)
    await admin.rpc('queue_calendar_sync', { p_booking_ids: [ids.booking] })
    expect(await sync().run()).toMatchObject({ synced: 1, failed: 0 })
    expect(google.live()).toHaveLength(2)
    expect(google.calls.some(([method]) => method === 'PUT')).toBe(true)
  })

  it('when Google fails, the booking waits to be tried again, then is marked failed, and the booking itself is never touched', async () => {
    const before = (await admin.from('bookings').select('*').eq('id', ids.booking).single()).data
    google.state.failNext = 500
    expect(await sync().run()).toMatchObject({ synced: 0, failed: 1 })
    const waiting = await queueRow(ids.booking)
    expect(waiting).toMatchObject({ attempt_count: 1, last_error: 'Google said 500 (backendError)', failed_at: null })
    expect(Date.parse(waiting.next_attempt_at)).toBeGreaterThan(Date.now())
    expect((await admin.from('calendar_connection').select('last_error').single()).data.last_error).toBe('Google said 500 (backendError)')
    // Its fifth failure marks it failed.
    await admin.from('calendar_sync_queue').update({ attempt_count: 4, next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq('booking_id', ids.booking)
    google.state.failNext = 503
    await sync().run()
    expect((await queueRow(ids.booking)).failed_at).not.toBeNull()
    expect((await admin.from('bookings').select('*').eq('id', ids.booking).single()).data).toEqual(before)
  })

  it('when Google refuses the saved sign-in, it stops, forgets the token and asks to connect again', async () => {
    google.state.tokenError = 'invalid_grant'
    expect(await sync().run()).toMatchObject({ stopped: 'needs reconnect' })
    expect(google.calls).toEqual([['TOKEN']])
    const connection = (await admin.from('calendar_connection').select('status,last_error,refresh_token_secret_id').single()).data
    expect(connection).toEqual({ status: 'needs_reconnect', last_error: 'Google asked you to connect again.', refresh_token_secret_id: null })
    google.calls.length = 0
    expect(await sync().run()).toEqual({ skipped: 'not connected' })
    expect(google.calls).toEqual([])
  })

  it('does nothing at all without its Google codes, or when not connected', async () => {
    expect(await createCalendarSync({ client: admin, config: readCalendarConfig({}), fetchImpl: google.fetchImpl }).run()).toEqual({ skipped: 'not configured' })
    await admin.rpc('calendar_forget_connection', { p_status: 'disconnected' })
    expect(await sync().run()).toEqual({ skipped: 'not connected' })
    expect(google.calls).toEqual([])
  })

  it('the 15-minute check finds a booking whose event is not what it should be', async () => {
    await sync().run()
    await admin.from('calendar_sync_events').update({ content_hash: 'changed' }).eq('booking_id', ids.booking).eq('kind', 'booking')
    await admin.from('calendar_connection').update({ last_check_at: new Date(Date.now() - 16 * 60 * 1000).toISOString() }).eq('id', true)
    const summary = await sync().run({ budgetMs: 0 })
    expect(summary.check).toBeGreaterThanOrEqual(1)
    expect(await queueRow(ids.booking)).not.toBeNull()
  })

  it('runs inside the every-minute sender once its Google codes are set, and a Google outage never stops the messages', async () => {
    const env = { CRON_SECRET: 'cron-secret', SUPABASE_URL: 'http://local', SUPABASE_SERVICE_ROLE_KEY: 'service-key', GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret' }
    const response = { headers: {}, setHeader(name, value) { this.headers[name] = value }, end(body) { this.body = body } }
    google.state.tokenError = 'server_error'
    // The repeat and reminder steps are left out here: they would change the shared local database for other tests.
    const quiet = new Proxy(admin, { get: (target, name) => name === 'rpc'
      ? (fn, args) => (['run_series_maintenance', 'plan_day_of_reminders'].includes(fn) ? Promise.resolve({ data: null, error: null }) : target.rpc(fn, args))
      : typeof target[name] === 'function' ? target[name].bind(target) : target[name] })
    await handle({ method: 'POST', headers: { authorization: 'Bearer cron-secret' } }, response, { env, createServiceClient: () => quiet, fetchImpl: google.fetchImpl })
    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body)
    expect(body).toHaveProperty('claimed')
    expect(body.calendar).toMatchObject({ failed: 1 })
    expect(response.body).not.toMatch(/refresh-token|access-token|client-secret/)
  })
})
