import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { paymentReviewFixture } from '../../tests/paymentReviewFixture.js'
import { createPaymentReviewApi, paymentActions } from './paymentReviewApi.js'
let f, api
beforeEach(async () => { f = await paymentReviewFixture(); api = createPaymentReviewApi(f.client) }, 30000)
afterEach(async () => { await f?.cleanup() }, 30000)
const args = (b, key = crypto.randomUUID()) => ({ p_booking_id: b.id, p_request_id: key, p_booking_updated_at: b.updated_at, p_payment_updated_at: b.booking_payments.updated_at })
const operations = ['admin_verify_bank_transfer', 'admin_approve_cash_request', 'admin_reject_cash_request', 'admin_remove_pending_booking', 'admin_record_payment_received']
describe('server-authoritative Admin payment commands', () => {
  it('denies non-admin and anonymous RPC calls and direct privileged writes', async () => {
    const raw = { p_booking_id: f.bookings[0].id, p_request_id: crypto.randomUUID(), p_booking_updated_at: new Date().toISOString(), p_payment_updated_at: new Date().toISOString() }
    for (const client of [f.client, f.publicClient]) {
      expect((await client.rpc('admin_payment_review_queue', { p_offset: 0 })).error).toBeTruthy()
      for (const op of operations) expect((await client.rpc(op, raw)).error).toBeTruthy()
      expect((await client.from('booking_payments').update({ status: 'approved' }).eq('booking_id', f.bookings[0].id)).error).toBeTruthy()
    }
    await expect(api.booking(f.bookings[0].id)).rejects.toThrow('Admin access')
    await f.authorize()
    for (const table of ['bookings', 'booking_payments']) expect((await f.client.from(table).delete().eq('id', f.bookings[0].id)).error?.code).toBe('42501')
  })
  it('lists only pending actionable pairs, excluding approved, paid, cancelled and rejected', async () => {
    await f.authorize()
    expect((await api.queue()).bookings.map(b => b.id)).toEqual(f.bookings.slice(0, 2).map(b => b.id))
    for (const [method, booking, payment] of [['cash','confirmed','approved'], ['bank_transfer','confirmed','paid'], ['cash','cancelled','rejected'], ['cash','cancelled','awaiting_approval']]) {
      await f.prepare(0, method, booking, payment)
      expect((await api.queue()).bookings.some(b => b.id === f.bookings[0].id)).toBe(false)
    }
    expect((await f.client.rpc('admin_payment_review_queue', { p_offset: -1 })).error?.code).toBe('22023')
  })
  it('lists a transfer the client has not declared, however old, and lets the Admin confirm or remove it', async () => {
    await f.authorize(); await f.prepare(0, 'bank_transfer', 'awaiting_transfer', 'awaiting_transfer')
    await f.admin.from('bookings').update({ created_at: new Date(Date.now() - 30 * 86400000).toISOString() }).eq('id', f.bookings[0].id)
    const listed = (await api.queue()).bookings.find(b => b.id === f.bookings[0].id)
    expect(listed).toBeTruthy()
    const b = await api.booking(f.bookings[0].id)
    expect(paymentActions(b)).toEqual(['verify', 'remove'])
    await api.act('verify', b, crypto.randomUUID())
    const confirmed = await api.booking(b.id)
    expect(confirmed.booking_status).toBe('confirmed'); expect(confirmed.booking_payments.status).toBe('paid')
    expect(confirmed.booking_payments.transfer_declared_at).toBeNull()
    expect(confirmed.booking_payments.verified_by).toBe(f.user.id)
  })
  it('removes a pending booking of any kind, records who did it, and never deletes it', async () => {
    await f.authorize()
    for (const [method, status, payment] of [['bank_transfer', 'awaiting_transfer', 'awaiting_transfer'], ['bank_transfer', 'awaiting_payment_verification', 'awaiting_verification'], ['cash', 'awaiting_cash_approval', 'awaiting_approval']]) {
      await f.prepare(0, method, status, payment)
      const b = await api.booking(f.bookings[0].id), key = crypto.randomUUID()
      await api.act('remove', b, key); await api.act('remove', b, key)
      const removed = await api.booking(b.id)
      expect(removed.booking_status).toBe('cancelled'); expect(removed.cancelled_by_actor_type).toBe('admin'); expect(removed.cancelled_by_actor_id).toBe(f.user.id)
      expect(removed.booking_payments.status).toBe('rejected')
      expect((await api.queue()).bookings.some(row => row.id === b.id)).toBe(false)
      const newest = (await f.admin.from('booking_status_events').select('to_status').eq('booking_id', b.id).eq('actor_type', 'admin').order('occurred_at', { ascending: false }).limit(2)).data
      expect(newest.map(e => e.to_status).sort()).toEqual(['cancelled', 'rejected'])
    }
  })
  it('verifies a transfer once, with atomic persisted audit and event; retries do not duplicate', async () => {
    await f.authorize(); const booking = await api.booking(f.bookings[0].id), key = crypto.randomUUID()
    await api.act('verify', booking, key)
    await api.act('verify', booking, key)
    const current = await api.booking(booking.id)
    expect(current.booking_status).toBe('confirmed'); expect(current.booking_payments.status).toBe('paid')
    expect(current.booking_payments.paid_at).toBeTruthy(); expect(current.booking_payments.verified_by).toBe(f.user.id)
    expect(paymentActions(current)).toEqual([])
    expect((await f.admin.from('command_requests').select('*').eq('scope', `admin-payment:${f.user.id}`)).data).toHaveLength(1)
    const events = (await f.admin.from('event_outbox').select('*').eq('aggregate_id', booking.id)).data
    expect(events).toHaveLength(1); expect(events[0].payload.payment_status).toBe('paid'); expect(events[0].source_command_id).toBeTruthy()
    await expect(api.act('verify', booking, crypto.randomUUID())).rejects.toMatchObject({ conflict: true })
    expect((await f.client.rpc('admin_approve_cash_request', args(booking, key))).error?.code).toBe('22023')
  })
  it('approves cash without receipt, then separately records actual receipt', async () => {
    await f.authorize(); const b = await api.booking(f.bookings[1].id)
    const approvalKey = crypto.randomUUID()
    await api.act('approve', b, approvalKey); await api.act('approve', b, approvalKey)
    const approved = await api.booking(b.id)
    expect(approved.booking_status).toBe('confirmed'); expect(approved.booking_payments.status).toBe('approved'); expect(approved.booking_payments.paid_at).toBeNull()
    expect(paymentActions(approved)).toEqual(['receive'])
    expect((await api.queue()).bookings.some(row => row.id === b.id)).toBe(false)
    const key = crypto.randomUUID()
    await api.act('receive', approved, key); await api.act('receive', approved, key)
    const paid = await api.booking(b.id)
    expect(paid.booking_status).toBe('confirmed'); expect(paid.booking_payments.status).toBe('paid'); expect(paid.booking_payments.paid_at).toBeTruthy()
    await expect(api.act('receive', paid, crypto.randomUUID())).rejects.toMatchObject({ conflict: true })
  })
  it('rejects cash atomically with cancellation metadata and removes queue item (legacy reject command)', async () => {
    await f.authorize(); const b = await api.booking(f.bookings[1].id), key = crypto.randomUUID()
    expect((await f.client.rpc('admin_reject_cash_request', args(b, key))).error).toBeNull()
    expect((await f.client.rpc('admin_reject_cash_request', args(b, key))).error).toBeNull()
    const rejected = await api.booking(b.id)
    expect(rejected.booking_status).toBe('cancelled'); expect(rejected.cancelled_at).toBeTruthy(); expect(rejected.cancelled_by_actor_id).toBe(f.user.id)
    expect(rejected.booking_payments.status).toBe('rejected'); expect(rejected.booking_payments.paid_at).toBeNull()
    expect((await api.queue()).bookings.some(row => row.id === b.id)).toBe(false)
    await expect(api.act('approve', rejected, crypto.randomUUID())).rejects.toMatchObject({ conflict: true })
  })
  it('rejects stale snapshots, invalid receipt, and amount mismatch without partial writes', async () => {
    await f.authorize(); const b = await api.booking(f.bookings[0].id)
    await f.admin.from('bookings').update({ client_note: 'Changed elsewhere' }).eq('id', b.id)
    await expect(api.act('verify', b, crypto.randomUUID())).rejects.toMatchObject({ conflict: true })
    const cash = await api.booking(f.bookings[1].id)
    await expect(api.act('receive', cash, crypto.randomUUID())).rejects.toMatchObject({ conflict: true })
    await f.admin.from('booking_payments').update({ amount_gbp: 1 }).eq('booking_id', b.id)
    await expect(api.act('verify', await api.booking(b.id), crypto.randomUUID())).rejects.toThrow('Could not complete')
    expect((await api.booking(b.id)).booking_status).toBe('awaiting_payment_verification')
    expect((await f.admin.from('command_requests').select('id').eq('scope', `admin-payment:${f.user.id}`)).data).toEqual([])
  })
  it('serializes concurrent approval/rejection so exactly one wins', async () => {
    await f.authorize(); const b = await api.booking(f.bookings[1].id)
    const results = await Promise.all([f.client.rpc('admin_approve_cash_request', args(b)), f.client.rpc('admin_reject_cash_request', args(b))])
    expect(results.filter(r => !r.error)).toHaveLength(1); expect(results.filter(r => r.error?.code === 'PT409')).toHaveLength(1)
    expect((await f.admin.from('event_outbox').select('id').eq('aggregate_id', b.id)).data).toHaveLength(1)
  })
  it('rejects every command for wrong method/state, paid, cancelled and provisional bookings', async () => {
    await f.authorize()
    const cases = [
      ['cash', 'awaiting_cash_approval', 'awaiting_approval', ['admin_approve_cash_request', 'admin_reject_cash_request', 'admin_remove_pending_booking']],
      ['bank_transfer', 'awaiting_payment_verification', 'awaiting_verification', ['admin_verify_bank_transfer', 'admin_remove_pending_booking']],
      ['cash', 'confirmed', 'approved', ['admin_record_payment_received']],
      ['bank_transfer', 'confirmed', 'paid', []], ['cash', 'cancelled', 'rejected', []],
      ['bank_transfer', 'awaiting_transfer', 'awaiting_transfer', ['admin_verify_bank_transfer', 'admin_remove_pending_booking']], ['cash', 'no_show', 'approved', []],
    ]
    for (const [method, status, payment, allowed] of cases) {
      await f.prepare(0, method, status, payment)
      const b = await api.booking(f.bookings[0].id)
      for (const op of operations.filter(op => !allowed.includes(op))) expect((await f.client.rpc(op, args(b))).error?.code).toBe('PT409')
      expect((await api.booking(b.id)).booking_payments.status).toBe(payment)
    }
    expect((await f.admin.from('command_requests').select('id').eq('scope', `admin-payment:${f.user.id}`)).data).toEqual([])
    expect((await f.admin.from('event_outbox').select('id').eq('aggregate_id', f.bookings[0].id)).data).toEqual([])
  })
  it('records completed cash receipt once even with simultaneous identical requests', async () => {
    await f.authorize(); await f.prepare(0, 'cash', 'completed', 'approved')
    const b = await api.booking(f.bookings[0].id), input = args(b)
    const results = await Promise.all([f.client.rpc('admin_record_payment_received', input), f.client.rpc('admin_record_payment_received', input)])
    expect(results.map(r => r.error)).toEqual([null, null])
    const current = await api.booking(b.id)
    expect(current.booking_status).toBe('completed'); expect(current.booking_payments.status).toBe('paid')
    expect(current.booking_payments.paid_at).toBeTruthy()
    expect((await f.admin.from('command_requests').select('id').eq('scope', `admin-payment:${f.user.id}`)).data).toHaveLength(1)
    expect((await f.admin.from('event_outbox').select('id').eq('aggregate_id', b.id)).data).toHaveLength(1)
  })
  it('rejects a changed payment version and revoked authorization, including replay of success', async () => {
    await f.authorize(); const b = await api.booking(f.bookings[0].id)
    expect((await f.admin.from('booking_payments').update({ amount_gbp: 85 }).eq('booking_id', b.id)).error).toBeNull()
    await expect(api.act('verify', b, crypto.randomUUID())).rejects.toMatchObject({ conflict: true })
    const current = await api.booking(b.id), input = args(current)
    expect((await f.client.rpc('admin_verify_bank_transfer', input)).error).toBeNull()
    expect((await f.admin.from('admin_users').delete().eq('user_id', f.user.id)).error).toBeNull()
    expect((await f.client.rpc('admin_verify_bank_transfer', input)).error?.code).toBe('42501')
    expect((await f.client.rpc('admin_payment_review_queue', { p_offset: 0 })).error?.code).toBe('42501')
  })
  it('bounds queue pages to 50 records and returns the next page', async () => {
    await f.authorize()
    const { id: ignoredId, ...base } = f.bookings[0]
    expect(ignoredId).toBeTruthy()
    const inserted = await f.admin.from('bookings').insert(Array.from({ length: 52 }, () => ({ ...base, booking_reference: crypto.randomUUID(), booking_status: 'awaiting_cash_approval' }))).select('id')
    expect(inserted.error).toBeNull()
    expect((await f.admin.from('booking_payments').insert(inserted.data.map(b => ({ booking_id: b.id, method: 'cash', status: 'awaiting_approval', amount_gbp: 85 })))).error).toBeNull()
    const first = await api.queue(), next = await api.queue(50)
    expect(first.bookings).toHaveLength(50); expect(first.hasMore).toBe(true)
    expect(next.bookings).toHaveLength(4); expect(next.hasMore).toBe(false)
    expect(new Set([...first.bookings, ...next.bookings].map(b => b.id)).size).toBe(54)
  })
})
