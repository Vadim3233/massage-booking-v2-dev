import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { adminFixture } from '../../tests/adminFixture.js'
import { unwrap } from '../client/booking/bookingApi.js'
import { shiftDate } from './calendarPresentation.js'
import { createClientsApi } from './clientsApi.js'
import { deleteScope } from './clientDelete.js'

const BOOKINGS = 'This client has bookings, so they cannot be deleted. Bookings, payments and receipts are your records.'
const GONE = 'That client is no longer there. They may already have been deleted or combined.'
const CHANGED = 'Something changed while you were deciding. Please look at the question again.'
const BOOKING_NOW = 'Someone is in the middle of booking right now. Try again in a few minutes.'

describe('deleting a client through the Admin API, against local Supabase', () => {
  let f, api
  let authorized = false
  // The Admin is made once; the first test checks the doors are shut before that.
  const authorize = async () => { if (!authorized) { await f.authorize(); authorized = true } }
  const made = { clients: [], users: [], waitlist: [], holds: [] }
  const options = { auth: { persistSession: false, autoRefreshToken: false } }
  const unique = () => crypto.randomUUID().slice(0, 8)
  const phone = () => `07911 ${String(Math.floor(Math.random() * 900000) + 100000)}`
  const exists = async id => Boolean((await f.admin.from('clients').select('id').eq('id', id).maybeSingle()).data)
  const userExists = async id => Boolean((await f.admin.auth.admin.getUserById(id)).data.user)
  // The way the page does it: look, then delete what the look said would go.
  const remove = async (id, key = crypto.randomUUID()) => api.deleteClient(id, key, deleteScope(await api.deleteCheck(id)))
  async function added(extra = {}) {
    const row = await unwrap(f.admin.from('clients').insert({ first_name: 'Del', last_name: `Test${unique()}`, email: `del-${unique()}@example.test`, phone: phone(), ...extra }).select().single())
    made.clients.push(row.id)
    return row
  }
  async function newUser(email) {
    const password = `Test-only-${crypto.randomUUID()}`
    const { user } = await unwrap(f.admin.auth.admin.createUser({ email, password, email_confirm: true }))
    made.users.push(user.id)
    return { user, password }
  }
  // A profile made when someone registers with a confirmed email, as a real registration does.
  async function activate(email, user, password) {
    const session = createClient(f.config.API_URL, f.config.ANON_KEY, options)
    await unwrap(session.auth.signInWithPassword({ email, password }))
    return session.rpc('activate_my_client_account', { p_first_name: 'Reg', p_last_name: 'Istered', p_phone: null })
  }
  async function registered(email) {
    const { user, password } = await newUser(email)
    const { data, error } = await activate(email, user, password)
    if (error) throw error
    made.clients.push(data[0].client_id)
    return { clientId: data[0].client_id, userId: user.id }
  }
  async function booking(clientId) {
    const { data, error } = await f.admin.from('bookings').insert({ client_id: clientId, service_area_id: f.ids.area, date: shiftDate(f.date, 4), start_minutes: 840, treatment_duration_minutes: 60,
      booking_status: 'confirmed', source_channel: 'web', address_line_1_snapshot: '12 Garden Road', city_snapshot: 'London', postcode_snapshot: 'SW1A1AA',
      service_area_name_snapshot: 'Test area', service_subtotal_gbp: 85, total_gbp: 85, booking_reference: `DEL-${crypto.randomUUID()}` }).select().single()
    return { row: data, error }
  }
  // A held time the way a visitor makes one: no client attached, only the browser's key.
  async function hold() {
    const row = await unwrap(f.admin.from('booking_holds').insert({ client_id: null, client_key: `integration-delete-key-${unique()}-${unique()}`, date: shiftDate(f.date, 5), start_minutes: 600,
      treatment_duration_minutes: 60, expires_at: new Date(Date.now() + 10 * 60000).toISOString(), status: 'active' }).select().single())
    made.holds.push(row.id)
    return row.id
  }

  beforeAll(async () => {
    f = await adminFixture(42)
    api = createClientsApi(f.client)
    // Held times left over from other work on this database would stop every deletion below.
    await f.admin.from('booking_holds').delete().not('id', 'is', null)
  }, 30000)
  afterAll(async () => {
    await f.admin.from('client_deletions').delete().eq('deleted_by', f.user.id)
    await f.admin.from('command_requests').delete().eq('scope', `admin-client-delete:${f.user.id}`)
    await f.admin.from('command_requests').delete().eq('scope', `admin-client:${f.user.id}`)
    if (made.holds.length) await f.admin.from('booking_holds').delete().in('id', made.holds)
    if (made.waitlist.length) {
      await f.admin.from('event_outbox').delete().in('aggregate_id', made.waitlist)
      await f.admin.from('waitlist_requests').delete().in('id', made.waitlist)
    }
    for (const id of made.clients) {
      const ids = ((await f.admin.from('bookings').select('id').eq('client_id', id)).data ?? []).map(row => row.id)
      if (ids.length) await f.admin.from('event_outbox').delete().in('aggregate_id', ids)
      await f.admin.from('bookings').delete().eq('client_id', id)
      await f.admin.from('event_outbox').delete().eq('aggregate_id', id)
      await f.admin.from('client_merges').delete().eq('kept_client_id', id)
      await f.admin.from('clients').delete().eq('id', id)
    }
    for (const id of made.users) await f.admin.auth.admin.deleteUser(id)
    await f?.cleanup()
  }, 30000)

  it('is closed to anyone who is not the Admin', async () => {
    const victim = await added()
    for (const client of [f.client, f.publicClient]) {
      const blocked = createClientsApi(client)
      await expect(blocked.deleteCheck(victim.id)).rejects.toThrow('Could not complete that.')
      await expect(blocked.deleteClient(victim.id, crypto.randomUUID(), { addresses: 0, notes: 0, waitlist: 0, login: 'added' })).rejects.toThrow('Could not complete that.')
      expect((await client.from('client_deletions').select('id')).error).toBeTruthy()
    }
    expect(await exists(victim.id)).toBe(true)
  })

  it('says what would go, then deletes a client with no bookings and keeps a record without personal details', async () => {
    await authorize()
    const row = await added()
    await unwrap(f.admin.from('client_addresses').insert([{ client_id: row.id, label: 'Home', address_line_1: '12 Garden Road', city: 'London', postcode: 'SW1A 2AA' }, { client_id: row.id, address_line_1: '7 Office Lane', city: 'London', postcode: 'EC1A 1BB' }]))
    await unwrap(f.admin.from('client_notes').insert({ client_id: row.id, note: 'Ring the top bell' }))
    const check = await api.deleteCheck(row.id)
    expect(check).toMatchObject({ found: true, can_delete: true, reason: null, bookings: 0, repeats: 0, addresses: 2, notes: 1, waitlist: 0, login: 'added' })
    const key = crypto.randomUUID()
    const result = await api.deleteClient(row.id, key, deleteScope(check))
    expect(result).toMatchObject({ deleted: true, addresses: 2, notes: 1, waitlist: 0, login: 'added' })
    expect(await exists(row.id)).toBe(false)
    expect((await f.admin.from('client_addresses').select('id').eq('client_id', row.id)).data).toEqual([])
    expect((await f.admin.from('client_notes').select('id').eq('client_id', row.id)).data).toEqual([])
    const record = (await f.admin.from('client_deletions').select('summary,deleted_by').eq('client_id', row.id)).data
    expect(record).toHaveLength(1)
    expect(record[0].deleted_by).toBe(f.user.id)
    expect(JSON.stringify(record[0].summary)).not.toMatch(new RegExp(`${row.last_name}|example\\.test|garden|office lane|top bell`, 'i'))
    // The same press again is answered, not done again; the page then reads that the client is gone.
    expect(await api.deleteClient(row.id, key, deleteScope(check))).toMatchObject({ deleted: true, repeat: true })
    expect(await api.deleteCheck(row.id)).toEqual({ found: false })
    await expect(api.deleteClient(row.id, crypto.randomUUID(), deleteScope(check))).rejects.toThrow(GONE)
  })

  it('refuses a client with a booking in the words written for her, and changes nothing', async () => {
    await authorize()
    const row = await added()
    const { error } = await booking(row.id)
    expect(error).toBeNull()
    expect(await api.deleteCheck(row.id)).toMatchObject({ can_delete: false, reason: 'bookings', bookings: 1 })
    await expect(remove(row.id)).rejects.toThrow(BOOKINGS)
    expect(await exists(row.id)).toBe(true)
    expect((await f.admin.from('bookings').select('id').eq('client_id', row.id)).data).toHaveLength(1)
  })

  it('removes the login of a client who registered, so the email can register again', async () => {
    await authorize()
    const email = `del-${unique()}@example.test`
    const { clientId, userId } = await registered(email)
    expect(await api.deleteCheck(clientId)).toMatchObject({ can_delete: true, login: 'registered' })
    expect(await remove(clientId)).toMatchObject({ deleted: true, login: 'registered' })
    expect(await exists(clientId)).toBe(false)
    expect(await userExists(userId)).toBe(false)
    const again = await f.admin.auth.admin.createUser({ email, password: `Test-only-${crypto.randomUUID()}`, email_confirm: true })
    expect(again.error).toBeNull()
    made.users.push(again.data.user.id)
  })

  it('also removes a waiting-list request made by their own login, which was never linked to a profile', async () => {
    await authorize()
    const email = `del-${unique()}@example.test`
    const { clientId, userId } = await registered(email)
    const request = await unwrap(f.admin.from('waitlist_requests').insert({ client_id: null, created_by: userId, contact_name: 'Reg Istered', contact_phone: phone(), requested_date: shiftDate(f.date, 6), duration_minutes: 60 }).select().single())
    made.waitlist.push(request.id)
    const other = await unwrap(f.admin.from('waitlist_requests').insert({ client_id: null, created_by: null, contact_name: 'Someone Else', contact_phone: phone(), requested_date: shiftDate(f.date, 6), duration_minutes: 60 }).select().single())
    made.waitlist.push(other.id)
    expect(await api.deleteCheck(clientId)).toMatchObject({ waitlist: 1, login: 'registered' })
    expect(await remove(clientId)).toMatchObject({ deleted: true, waitlist: 1 })
    expect((await f.admin.from('waitlist_requests').select('id').eq('id', request.id)).data).toEqual([])
    expect((await f.admin.from('waitlist_requests').select('id').eq('id', other.id)).data).toHaveLength(1)
  })

  it('removes the combine history of a profile that was combined into one that was combined', async () => {
    await authorize()
    const kept = await added()
    const middle = crypto.randomUUID()
    const first = crypto.randomUUID()
    const merge = (keptId, removedId) => ({ kept_client_id: keptId, removed_client_id: removedId, removed_client: { first_name: 'Old', email: `old-${unique()}@example.test` }, removed_kind: 'guest', moved: {}, summary: {} })
    await unwrap(f.admin.from('client_merges').insert([merge(kept.id, middle), merge(middle, first)]))
    expect(await remove(kept.id)).toMatchObject({ deleted: true, history: 2 })
    expect((await f.admin.from('client_merges').select('id').in('kept_client_id', [kept.id, middle])).data).toEqual([])
  })

  it('never deletes the Admin\'s own profile or login', async () => {
    await authorize()
    // The test Admin may already have a client profile of their own; if not, make one.
    let own = (await f.admin.from('clients').select('id').eq('auth_user_id', f.user.id).maybeSingle()).data
    const madeHere = !own
    if (madeHere) own = await added({ auth_user_id: f.user.id })
    expect(await api.deleteCheck(own.id)).toMatchObject({ can_delete: false, reason: 'admin' })
    await expect(remove(own.id)).rejects.toThrow('This client is signed in as an Admin, so they cannot be deleted here.')
    expect(await exists(own.id)).toBe(true)
    expect(await userExists(f.user.id)).toBe(true)
    if (madeHere) await f.admin.from('clients').update({ auth_user_id: null }).eq('id', own.id)
  })

  it('stops while a visitor is booking, says so, and works again when the held time is gone', async () => {
    await authorize()
    const row = await added()
    const heldId = await hold()
    expect(await api.deleteCheck(row.id)).toMatchObject({ can_delete: false, reason: 'booking_now' })
    await expect(api.deleteClient(row.id, crypto.randomUUID(), { addresses: 0, notes: 0, waitlist: 0, login: 'added' })).rejects.toThrow(BOOKING_NOW)
    expect(await exists(row.id)).toBe(true)
    await f.admin.from('booking_holds').update({ status: 'released' }).eq('id', heldId)
    expect(await api.deleteCheck(row.id)).toMatchObject({ can_delete: true })
    expect(await remove(row.id)).toMatchObject({ deleted: true })
  })

  it('asks again, and deletes nothing, when something changed after the question was put', async () => {
    await authorize()
    const row = await added()
    const asked = await api.deleteCheck(row.id)
    await unwrap(f.admin.from('client_notes').insert({ client_id: row.id, note: 'Added after the question' }))
    await expect(api.deleteClient(row.id, crypto.randomUUID(), deleteScope(asked))).rejects.toThrow(CHANGED)
    expect(await exists(row.id)).toBe(true)
    const again = await api.deleteCheck(row.id)
    expect(again).toMatchObject({ notes: 1 })
    expect(await api.deleteClient(row.id, crypto.randomUUID(), deleteScope(again))).toMatchObject({ deleted: true, notes: 1 })
  })

  it('does not delete a login that was not in the question: someone registering after it was put', async () => {
    await authorize()
    const email = `del-${unique()}@example.test`
    const row = await added({ email })
    const asked = await api.deleteCheck(row.id)
    expect(asked.login).toBe('added')
    const { user, password } = await newUser(email)
    const { data, error } = await activate(email, user, password)
    expect(error).toBeNull()
    expect(data[0].client_id).toBe(row.id)
    await expect(api.deleteClient(row.id, crypto.randomUUID(), deleteScope(asked))).rejects.toThrow(CHANGED)
    expect(await exists(row.id)).toBe(true)
    expect(await userExists(user.id)).toBe(true)
  })

  it('does the work once when the same press arrives twice at the same moment', async () => {
    await authorize()
    const row = await added()
    const key = crypto.randomUUID()
    const expected = deleteScope(await api.deleteCheck(row.id))
    const results = await Promise.all([api.deleteClient(row.id, key, expected), api.deleteClient(row.id, key, expected)])
    expect(results.every(result => result.deleted === true)).toBe(true)
    expect(results.filter(result => result.repeat === true)).toHaveLength(1)
    expect((await f.admin.from('client_deletions').select('id').eq('client_id', row.id)).data).toHaveLength(1)
  })

  it('lets only one of two rival requests delete, and tells the other the client has gone', async () => {
    await authorize()
    const row = await added()
    const expected = deleteScope(await api.deleteCheck(row.id))
    const settled = await Promise.allSettled([api.deleteClient(row.id, crypto.randomUUID(), expected), api.deleteClient(row.id, crypto.randomUUID(), expected)])
    expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    const lost = settled.find(item => item.status === 'rejected')
    expect(lost.reason.message).toBe(GONE)
    expect((await f.admin.from('client_deletions').select('id').eq('client_id', row.id)).data).toHaveLength(1)
  })

  it('never leaves a booking without its client when a booking arrives at the same moment', async () => {
    await authorize()
    const outcomes = []
    for (let round = 0; round < 8; round += 1) {
      const row = await added()
      const expected = deleteScope(await api.deleteCheck(row.id))
      const [deletion, made_booking] = await Promise.allSettled([api.deleteClient(row.id, crypto.randomUUID(), expected), booking(row.id)])
      const bookingExists = (await f.admin.from('bookings').select('id').eq('client_id', row.id)).data.length > 0
      const clientExists = await exists(row.id)
      // Either the client went and the booking could not be made, or the booking stands and so does the client: never a booking alone.
      expect(clientExists || !bookingExists).toBe(true)
      if (deletion.status === 'fulfilled') { expect(clientExists).toBe(false); expect(made_booking.value.error).toBeTruthy(); outcomes.push('deleted') }
      else { expect(deletion.reason.message).toBe(BOOKINGS); expect(clientExists).toBe(true); expect(bookingExists).toBe(true); outcomes.push('kept') }
    }
    expect(outcomes).toHaveLength(8)
  })

  it('stays consistent when someone registers with the client\'s email at the same moment', async () => {
    await authorize()
    for (let round = 0; round < 4; round += 1) {
      const email = `del-${unique()}@example.test`
      const row = await added({ email })
      const expected = deleteScope(await api.deleteCheck(row.id))
      const { user, password } = await newUser(email)
      const [deletion, activation] = await Promise.allSettled([api.deleteClient(row.id, crypto.randomUUID(), expected), activate(email, user, password)])
      if (activation.status === 'fulfilled' && activation.value.data?.[0]) made.clients.push(activation.value.data[0].client_id)
      const stillThere = await userExists(user.id)
      const linked = (await f.admin.from('clients').select('id').eq('auth_user_id', user.id)).data ?? []
      if (deletion.status === 'fulfilled') {
        // The deletion came first (the registration then made a fresh profile for the new login), or the registration linked the
        // profile first and the deletion then caught the change and would have to be asked again.
        expect(await exists(row.id)).toBe(false)
        if (stillThere) expect(linked).toHaveLength(1)
        else expect(linked).toHaveLength(0)
      } else {
        // The registration linked the profile before the deletion could look: it was refused because the question had not mentioned a login.
        expect(deletion.reason.message).toBe(CHANGED)
        expect(await exists(row.id)).toBe(true)
        expect(stillThere).toBe(true)
        expect(linked).toHaveLength(1)
      }
    }
  })
})
