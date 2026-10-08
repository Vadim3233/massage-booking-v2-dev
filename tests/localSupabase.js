import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { createBookingApi, unwrap } from '../src/client/booking/bookingApi.js'
import { londonDate } from '../src/client/booking/bookingDraft.js'

export function localConfig() {
  // Never accept a remote URL or remote credentials from .env.local.
  const output = execFileSync(process.execPath, ['node_modules/supabase/dist/supabase.js', 'status', '-o', 'json'], { encoding: 'utf8', windowsHide: true })
  const config = JSON.parse(output.slice(output.indexOf('{')))
  const url = new URL(config.API_URL)
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Tests require local Supabase')
  return config
}

export async function localFixture(offset = 20) {
  const config = localConfig()
  const options = { auth: { persistSession: false, autoRefreshToken: false } }
  const admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, options)
  const publicClient = createClient(config.API_URL, config.ANON_KEY, options)
  const client = createClient(config.API_URL, config.ANON_KEY, options)
  const api = createBookingApi(client)
  const publicApi = createBookingApi(publicClient)
  const ids = Object.fromEntries(['area', 'service', 'enhancement', 'preference', 'conflicting'].map((key) => [key, crypto.randomUUID()]))
  const date = londonDate(offset)
  const email = `v2-${crypto.randomUUID()}@example.test`
  const password = `Test-only-${crypto.randomUUID()}`
  const users = []
  const clientIds = []
  const keys = []
  const overrides = await unwrap(admin.from('working_hours_overrides').select('date,available,start_minutes,end_minutes,start_mode,fixed_start_minutes').eq('date', date))
  await unwrap(admin.from('working_hours_overrides').upsert({ date, available: true, start_minutes: 600, end_minutes: 1320, start_mode: 'flexible', fixed_start_minutes: null }))
  await unwrap(admin.from('services').insert({ id: ids.service, slug: ids.service, name: 'Integration massage', short_description: 'Local test treatment', active: true }))
  await unwrap(admin.from('service_duration_prices').insert([60, 90, 120].map((duration, i) => ({ service_id: ids.service, duration_minutes: duration, price_gbp: [85, 115, 160][i] }))))
  await unwrap(admin.from('service_areas').insert({ id: ids.area, slug: ids.area, name: 'Integration area', travel_surcharge_gbp: 12, congestion_fee_gbp: 8 }))
  await unwrap(admin.from('enhancements').insert({ id: ids.enhancement, slug: ids.enhancement, name: 'Integration enhancement', price_gbp: 10, duration_minutes: 15 }))
  await unwrap(admin.from('session_preferences').insert([
    { id: ids.preference, slug: ids.preference, label: 'Integration focus', category: 'Focus' },
    { id: ids.conflicting, slug: ids.conflicting, label: 'Integration avoid', category: 'Focus' },
  ]))
  await unwrap(admin.from('session_preference_conflicts').insert({ preference_id: ids.preference, conflicting_preference_id: ids.conflicting }))
  const auth = await unwrap(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { first_name: 'Test', last_name: 'Client' } }))
  users.push(auth.user.id)
  await unwrap(client.auth.signInWithPassword({ email, password }))
  const profile = await api.activate({ first_name: 'Test', last_name: 'Client', phone: '+447700900001' })
  clientIds.push(profile.client_id)
  return { config, admin, client, publicClient, api, publicApi, ids, date, email, password, profile,
    async trackUser(id) {
      users.push(id)
      const rows = await unwrap(admin.from('clients').select('id').eq('auth_user_id', id))
      clientIds.push(...rows.map((row) => row.id))
    },
    key() { const key = crypto.randomUUID(); keys.push(key); return key },
    trackKey(key) { if (key) keys.push(key) },
    async cleanup() {
      // Fixture-owned rows only, on the explicitly verified local endpoint.
      for (const clientId of clientIds) {
        const bookings = await unwrap(admin.from('bookings').select('id').eq('client_id', clientId))
        for (const booking of bookings) await unwrap(admin.from('event_outbox').delete().eq('aggregate_id', booking.id))
        await unwrap(admin.from('command_requests').delete().eq('scope', `client-finalize:${clientId}`))
        await unwrap(admin.from('bookings').delete().eq('client_id', clientId))
        await unwrap(admin.from('clients').delete().eq('id', clientId))
      }
      for (const key of keys) await unwrap(admin.from('booking_holds').delete().eq('client_key', key))
      await unwrap(admin.from('session_preference_conflicts').delete().eq('preference_id', ids.preference))
      await unwrap(admin.from('session_preferences').delete().in('id', [ids.preference, ids.conflicting]))
      await unwrap(admin.from('enhancements').delete().eq('id', ids.enhancement))
      await unwrap(admin.from('service_duration_prices').delete().eq('service_id', ids.service))
      await unwrap(admin.from('services').delete().eq('id', ids.service))
      await unwrap(admin.from('service_areas').delete().eq('id', ids.area))
      if (overrides.length) await unwrap(admin.from('working_hours_overrides').upsert(overrides))
      else await unwrap(admin.from('working_hours_overrides').delete().eq('date', date))
      for (const id of users) {
        await unwrap(admin.from('command_requests').delete().eq('scope', `client-self-service:${id}`))
        await unwrap(admin.auth.admin.deleteUser(id))
      }
      await client.auth.signOut()
    },
  }
}
