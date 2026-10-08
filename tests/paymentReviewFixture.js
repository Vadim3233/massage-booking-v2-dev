import { adminFixture } from './adminFixture.js'
import { unwrap } from '../src/client/booking/bookingApi.js'
export async function paymentReviewFixture() {
  const f = await adminFixture(37)
  // Status changes are guarded by database triggers, so a fixture cannot rewind a booking in place.
  // Recreate the booking and payment under the same id in the requested state instead.
  async function prepare(index, method, bookingStatus, paymentStatus) {
    const id = f.bookings[index].id
    const booking = await unwrap(f.admin.from('bookings').select().eq('id', id).single())
    const sessions = await unwrap(f.admin.from('booking_sessions').select().eq('booking_id', id))
    await unwrap(f.admin.from('bookings').delete().eq('id', id))
    await unwrap(f.admin.from('bookings').insert({ ...booking, booking_status: bookingStatus, cancelled_at: bookingStatus === 'cancelled' ? new Date().toISOString() : null, cancelled_by_actor_type: null, cancelled_by_actor_id: null,
      payment_reservation_expires_at: bookingStatus === 'awaiting_transfer' ? new Date(Date.now() - 60000).toISOString() : null }))
    await unwrap(f.admin.from('booking_sessions').insert(sessions))
    await unwrap(f.admin.from('booking_payments').insert({ booking_id: id, method, status: paymentStatus, amount_gbp: 85, paid_at: paymentStatus === 'paid' ? new Date().toISOString() : null }))
  }
  await prepare(0, 'bank_transfer', 'awaiting_payment_verification', 'awaiting_verification')
  await prepare(1, 'cash', 'awaiting_cash_approval', 'awaiting_approval')
  return { ...f, prepare,
    async cleanup() {
      for (const b of f.bookings) await unwrap(f.admin.from('event_outbox').delete().eq('aggregate_id', b.id))
      await unwrap(f.admin.from('command_requests').delete().eq('scope', `admin-payment:${f.user.id}`))
      await f.cleanup()
    },
  }
}
