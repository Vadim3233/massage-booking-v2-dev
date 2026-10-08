import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { paymentReviewFixture } from '../../tests/paymentReviewFixture.js'
import { createLifecycleApi } from './bookingLifecycleApi.js'
import { createPaymentReviewApi } from './paymentReviewApi.js'

let f, api, review
beforeEach(async () => { f = await paymentReviewFixture(); api = createLifecycleApi(f.client); review = createPaymentReviewApi(f.client) }, 30000)
afterEach(async () => { await f?.cleanup() }, 30000)
const fresh = id => review.booking(id)

describe('Admin booking lifecycle against local Supabase', () => {
  it('refuses everyone who is not an Admin', async () => {
    const b = f.bookings[0]
    await expect(api.act('cancel', { ...b, booking_payments: { updated_at: b.updated_at } }, crypto.randomUUID(), { reason: 'x', initiatedBy: 'admin', fee: 0 })).rejects.toThrow('Could not complete the action')
    expect((await f.admin.from('bookings').select('booking_status').eq('id', b.id).single()).data.booking_status).toBe('awaiting_payment_verification')
  })

  it('cancels a pending booking far in advance for free, with a reason and history', async () => {
    await f.authorize()
    const b = await fresh(f.bookings[0].id)
    expect(await api.preview(b.id, 'client')).toBe(0)
    await api.act('cancel', b, crypto.randomUUID(), { reason: 'Client is travelling', initiatedBy: 'client', fee: null })
    const cancelled = await fresh(b.id)
    expect(cancelled).toMatchObject({ booking_status: 'cancelled', cancellation_reason: 'Client is travelling', cancellation_initiated_by: 'client', late_fee_status: 'none', cancelled_by_actor_id: f.user.id })
    expect(cancelled.booking_payments.status).toBe('rejected')
    const history = await api.history(b.id)
    expect(history.some(event => event.kind === 'booking' && event.to_status === 'cancelled' && event.actor_type === 'admin')).toBe(true)
  })

  it('reschedules into free time, ignoring the booking itself, and records the move', async () => {
    await f.authorize()
    const b = await fresh(f.bookings[2].id)
    const withItself = await api.availability(b.date, b.treatment_duration_minutes, null)
    const times = await api.availability(b.date, b.treatment_duration_minutes, b.id)
    expect(times.length).toBeGreaterThan(withItself.length)
    const target = times[1]
    await api.act('reschedule', b, crypto.randomUUID(), { date: b.date, start: target, initiatedBy: 'admin' })
    const moved = await fresh(b.id)
    expect(moved.start_minutes).toBe(target)
    expect((await api.history(b.id)).some(event => event.kind === 'schedule' && event.to_start_minutes === target)).toBe(true)
  })

  it('refuses a clash with another booking and explains it, without raw errors', async () => {
    await f.authorize()
    const other = await fresh(f.bookings[2].id)
    await expect(api.act('reschedule', other, crypto.randomUUID(), { date: f.bookings[0].date, start: 600, initiatedBy: 'admin' }))
      .rejects.toMatchObject({ message: 'This time is not available. Choose another time.', conflict: false })
  })

  it('will not complete an appointment that has not started', async () => {
    await f.authorize()
    const b = await fresh(f.bookings[2].id)
    await expect(api.act('complete', b, crypto.randomUUID())).rejects.toThrow('The appointment has not started yet')
  })

  it('treats a changed booking as a conflict and asks for a refresh', async () => {
    await f.authorize()
    const stale = await fresh(f.bookings[0].id)
    await f.admin.from('bookings').update({ client_note: 'Changed elsewhere' }).eq('id', stale.id)
    await expect(api.act('cancel', stale, crypto.randomUUID(), { reason: 'x', initiatedBy: 'admin', fee: 0 })).rejects.toMatchObject({ conflict: true })
  })

  it('retries the same request safely', async () => {
    await f.authorize()
    const b = await fresh(f.bookings[0].id), key = crypto.randomUUID()
    await api.act('cancel', b, key, { reason: 'Same request', initiatedBy: 'admin', fee: 0 })
    await api.act('cancel', b, key, { reason: 'Same request', initiatedBy: 'admin', fee: 0 })
    expect((await f.admin.from('event_outbox').select('id').eq('aggregate_id', b.id).eq('event_type', 'booking.cancelled')).data).toHaveLength(1)
  })
})
