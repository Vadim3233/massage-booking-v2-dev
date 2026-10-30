import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { adminFixture } from '../../tests/adminFixture.js'
import { removeReceipts } from '../../tests/localSupabase.js'
import { unwrap } from '../client/booking/bookingApi.js'
import { createAlertsApi } from './alertsApi.js'
import { shiftDate } from './calendarPresentation.js'
import { createClientsApi } from './clientsApi.js'

describe('combining two profiles through the Admin API, against local Supabase', () => {
  let f, api
  let authorized = false
  // The Admin is made once; the first test checks the doors are shut before that.
  const authorize = async () => { if (!authorized) { await f.authorize(); authorized = true } }
  const made = { clients: [], users: [] }
  const options = { auth: { persistSession: false, autoRefreshToken: false } }
  const unique = () => crypto.randomUUID().slice(0, 8)
  const phone = () => `07911 ${String(Math.floor(Math.random() * 900000) + 100000)}`
  // A profile a guest session makes, as a real guest booking does.
  async function guestProfile(email) {
    const session = createClient(f.config.API_URL, f.config.ANON_KEY, options)
    const { user } = await unwrap(session.auth.signInAnonymously())
    made.users.push(user.id)
    const [row] = await unwrap(session.rpc('activate_guest_client_account', { p_first_name: 'Olo', p_last_name: 'Ehe', p_email: email, p_phone: phone() }))
    made.clients.push(row.client_id)
    return row.client_id
  }
  // A profile made when someone registers with a confirmed email, as a real registration does.
  async function registered(email, last = 'Ehe') {
    const password = `Test-only-${crypto.randomUUID()}`
    const { user } = await unwrap(f.admin.auth.admin.createUser({ email, password, email_confirm: true }))
    made.users.push(user.id)
    const session = createClient(f.config.API_URL, f.config.ANON_KEY, options)
    await unwrap(session.auth.signInWithPassword({ email, password }))
    const [row] = await unwrap(session.rpc('activate_my_client_account', { p_first_name: 'Olo', p_last_name: last, p_phone: null }))
    made.clients.push(row.client_id)
    return row.client_id
  }
  async function added(email, last = 'Added') {
    const row = await unwrap(f.admin.from('clients').insert({ first_name: 'Olo', last_name: last, email, phone: phone() }).select().single())
    made.clients.push(row.id)
    return row.id
  }
  async function booking(clientId, days) {
    const row = await unwrap(f.admin.from('bookings').insert({ client_id: clientId, service_area_id: f.ids.area, date: shiftDate(f.date, days), start_minutes: 840, treatment_duration_minutes: 60,
      booking_status: 'confirmed', source_channel: 'web', address_snapshot: '12 Garden Road, London, SW1A 1AA',
      service_area_name_snapshot: 'Test area', service_subtotal_gbp: 85, total_gbp: 85, booking_reference: `SAME-${crypto.randomUUID()}` }).select().single())
    await unwrap(f.admin.from('booking_payments').insert({ booking_id: row.id, method: 'cash', status: 'approved', amount_gbp: 85 }))
    return row.id
  }

  beforeAll(async () => {
    f = await adminFixture(41)
    api = createClientsApi(f.client)
  }, 30000)
  afterAll(async () => {
    await f.admin.from('event_outbox').delete().in('aggregate_id', made.clients)
    await f.admin.from('client_merges').delete().in('kept_client_id', made.clients)
    await f.admin.from('command_requests').delete().in('scope', [`admin-client-merge:${f.user.id}`, `admin-booking:${f.user.id}`])
    for (const id of made.clients) {
      const bookings = (await f.admin.from('booking_series').select('id').eq('client_id', id)).data ?? []
      for (const row of bookings) await f.admin.from('event_outbox').delete().eq('aggregate_id', row.id)
      const ids = ((await f.admin.from('bookings').select('id').eq('client_id', id)).data ?? []).map(row => row.id)
      if (ids.length) await f.admin.from('event_outbox').delete().in('aggregate_id', ids)
      await f.admin.from('booking_series').delete().eq('client_id', id)
      await removeReceipts(f.admin, { clientId: id })
      await f.admin.from('bookings').delete().eq('client_id', id)
      await f.admin.from('clients').delete().eq('id', id)
    }
    await f.admin.from('business_settings').delete().eq('key', 'series_payment_reminder_days')
    await f.admin.from('working_hours_overrides').delete().in('date', [shiftDate(f.date, 2), shiftDate(f.date, 9)])
    for (const id of made.users) await f.admin.auth.admin.deleteUser(id)
    await f?.cleanup()
  }, 30000)

  it('is closed to anyone who is not the Admin', async () => {
    for (const client of [f.client, f.publicClient]) {
      const blocked = createClientsApi(client)
      await expect(blocked.possibleDuplicates()).rejects.toThrow('Could not complete that.')
      await expect(blocked.combinePreview(crypto.randomUUID(), crypto.randomUUID())).rejects.toThrow('Could not complete that.')
      await expect(blocked.keepSeparate(crypto.randomUUID(), crypto.randomUUID())).rejects.toThrow('Could not complete that.')
      await expect(blocked.combine(crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID())).rejects.toThrow('Could not complete that.')
      expect((await client.from('client_not_same').select('client_a')).error).toBeTruthy()
    }
    expect((await f.client.from('client_merges').select('id')).data ?? []).toEqual([])
  })

  it('notices a guest and a registration with the same email, and combines them when asked', async () => {
    await authorize()
    const email = `same-${unique()}@example.test`
    const guest = await guestProfile(email)
    await booking(guest, 3)
    const login = await registered(email)       // used to be refused: "already linked to another client account"
    const pair = (await api.possibleDuplicates()).find(row => [row.client_a, row.client_b].includes(guest) && [row.client_a, row.client_b].includes(login))
    expect(pair).toMatchObject({ matched_on: ['email'], a_name: 'Olo Ehe', b_name: 'Olo Ehe' })
    expect([pair.a_kind, pair.b_kind].sort()).toEqual(['guest', 'registered'])
    const alert = (await createAlertsApi(f.client).list()).find(row => row.link_path === `/admin/clients/combine?a=${login}&b=${guest}`)
    expect(alert).toMatchObject({ title: 'Is this the same person?', read_at: null })

    const preview = await api.combinePreview(login, guest)
    expect(preview).toMatchObject({ can_combine: true, keep_id: login, kept_separate: false, matched_on: ['email'] })
    expect(preview.profiles.map(row => [row.kind, row.bookings])).toEqual([['registered', 0], ['guest', 1]])

    const requestId = crypto.randomUUID()
    expect(await api.combine(login, guest, requestId)).toMatchObject({ kept_id: login, removed_id: guest, bookings: 1, notes: 0, addresses: 0 })
    expect(await api.combine(login, guest, requestId)).toMatchObject({ repeat: true, bookings: 1 })
    expect(await api.combine(login, guest, crypto.randomUUID())).toMatchObject({ repeat: true })
    expect((await api.bookings(login, 0, 5)).length).toBe(1)
    expect((await f.admin.from('clients').select('id').eq('id', guest)).data).toEqual([])
    expect((await api.possibleDuplicates()).some(row => [row.client_a, row.client_b].includes(guest))).toBe(false)
    expect((await createAlertsApi(f.client).list()).find(row => row.id === alert.id).read_at).not.toBeNull()
    const history = (await f.client.from('client_merges').select('kept_client_id,removed_client_id,removed_kind,merged_by').eq('kept_client_id', login)).data
    expect(history).toEqual([{ kept_client_id: login, removed_client_id: guest, removed_kind: 'guest', merged_by: f.user.id }])
  })

  it('refuses what cannot be combined, in the words written for the Admin, and moves nothing', async () => {
    await authorize()
    const one = await registered(`same-${unique()}@example.test`, 'First')
    const two = await registered(`same-${unique()}@example.test`, 'Second')
    const none = await added(`same-${unique()}@example.test`)
    await booking(two, 5)
    await expect(api.combine(one, two, crypto.randomUUID())).rejects.toThrow('Two clients who each have their own login cannot be combined.')
    await expect(api.combine(none, two, crypto.randomUUID())).rejects.toThrow('The client with the login is the one that stays.')
    await expect(api.combine(one, crypto.randomUUID(), crypto.randomUUID())).rejects.toThrow('One of these clients is no longer there. They may already have been combined.')
    await expect(api.combinePreview(one, crypto.randomUUID())).rejects.toThrow('One of these clients is no longer there.')
    expect((await api.combinePreview(one, two)).can_combine).toBe(false)
    expect((await api.bookings(two, 0, 5)).length).toBe(1)
    expect((await f.admin.from('clients').select('id').in('id', [one, two, none])).data).toHaveLength(3)
    // Two profiles that each have a login are never offered as a pair.
    const offered = await api.possibleDuplicates()
    expect(offered.some(row => [row.client_a, row.client_b].includes(one) && [row.client_a, row.client_b].includes(two))).toBe(false)
  })

  it('keeps a weekly repeat booking for the profile that stays, with the address it was made with', async () => {
    await authorize()
    const login = await registered(`same-${unique()}@example.test`, 'Weekly')
    const none = await added(`same-${unique()}@example.test`, 'Weekly')
    const mine = await unwrap(f.admin.from('client_addresses').insert({ client_id: none, address: '5 Weekly Walk, London, SW1A 1AA', is_default: true }).select().single())
    const copy = await unwrap(f.admin.from('client_addresses').insert({ client_id: login, address: '5 weekly walk,  London,sw1a 1aa', is_default: true }).select().single())
    // A free day (the fixture has its own bookings on its date) and the same weekday a week later, both open all day.
    const first = shiftDate(f.date, 2)
    const next = shiftDate(first, 7)
    await unwrap(f.admin.from('working_hours_overrides').upsert([first, next].map(date => ({ date, available: true, start_minutes: 0, end_minutes: 1440, start_mode: 'flexible' })), { onConflict: 'date' }))
    await unwrap(f.admin.from('business_settings').upsert({ key: 'series_payment_reminder_days', value: 55 }, { onConflict: 'key' }))
    // The repeat is made the way the Admin makes one, so it keeps a copy of the booking it makes: the client and the saved address.
    const request = { client_id: none, saved_address_id: mine.id, service_area_id: f.ids.area, date: first, start_minutes: 600, payment_arrangement: 'bank_pending', note: null,
      sessions: [{ service_id: f.ids.service, duration_minutes: 60, recipient_name: 'Weekly Client', preference_ids: [] }], enhancement_ids: [] }
    const [series] = await unwrap(f.client.rpc('admin_create_series', { p_request: request, p_end_date: null, p_request_id: crypto.randomUUID() }))
    expect(await api.combine(login, none, crypto.randomUUID())).toMatchObject({ kept_id: login, removed_id: none, bookings: 1, repeats: 1, addresses: 0 })
    const stored = (await unwrap(f.admin.from('booking_series').select('client_id,request').eq('id', series.series_id).single()))
    expect(stored.client_id).toBe(login)
    expect(stored.request).toMatchObject({ client_id: login, saved_address_id: copy.id })
    // The daily job still makes the next session, for the profile that stays; before the fix it gave the date up as a clash.
    const result = await unwrap(f.admin.rpc('run_series_maintenance'))
    expect(result.made).toBeGreaterThanOrEqual(1)
    const sessions = await unwrap(f.admin.from('bookings').select('client_id,saved_address_id,date,booking_status').eq('series_id', series.series_id).order('date'))
    expect(sessions.map(row => row.date)).toEqual([first, next])
    expect(sessions.every(row => row.client_id === login)).toBe(true)
    expect(sessions[1]).toMatchObject({ saved_address_id: copy.id, booking_status: 'confirmed' })
    expect((await f.admin.from('booking_series_skips').select('date').eq('series_id', series.series_id).eq('reason', 'clash')).data).toEqual([])
  })

  it('lets a profile that shares an email be corrected, but still refuses a new email another profile uses', async () => {
    await authorize()
    const email = `same-${unique()}@example.test`
    const first = await added(email, 'Family')
    const second = await added(email, 'Shared')
    const other = await added(`same-${unique()}@example.test`, 'Other')
    const mine = await unwrap(f.admin.from('clients').select('first_name,email,phone').eq('id', first).single())
    await api.keepSeparate(first, second)
    await expect(api.update(first, { first_name: mine.first_name, last_name: 'Renamed', email: mine.email, phone: mine.phone })).resolves.toMatchObject({ last_name: 'Renamed', email })
    const taken = (await unwrap(f.admin.from('clients').select('email').eq('id', other).single())).email
    await expect(api.update(first, { first_name: mine.first_name, last_name: 'Renamed', email: taken, phone: mine.phone })).rejects.toThrow('Another client already uses this email or phone.')
  })

  it('remembers that two profiles are different people', async () => {
    await authorize()
    const email = `same-${unique()}@example.test`
    const first = await added(email, 'Family')
    const second = await added(email, 'Shared')
    const listed = rows => rows.some(row => [row.client_a, row.client_b].includes(first) && [row.client_a, row.client_b].includes(second))
    expect(listed(await api.possibleDuplicates())).toBe(true)
    await api.keepSeparate(second, first)
    await api.keepSeparate(first, second)
    expect(listed(await api.possibleDuplicates())).toBe(false)
    expect((await api.combinePreview(first, second)).kept_separate).toBe(true)
    // Changing a detail does not bring the question back.
    await f.admin.from('clients').update({ phone: phone() }).eq('id', first)
    expect(listed(await api.possibleDuplicates())).toBe(false)
  })
})
