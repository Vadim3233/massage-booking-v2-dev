import { adminFixture } from './adminFixture.js'
import { unwrap } from '../src/client/booking/bookingApi.js'
export async function paymentReviewFixture() {
  const f = await adminFixture(37)
  async function prepare(index, method, bookingStatus, paymentStatus) {
    const id = f.bookings[index].id
    await unwrap(f.admin.from('bookings').update({ booking_status: bookingStatus, cancelled_at: bookingStatus === 'cancelled' ? new Date().toISOString() : null, cancelled_by_actor_type: null, cancelled_by_actor_id: null,
      payment_reservation_expires_at: bookingStatus === 'awaiting_transfer' ? new Date(Date.now() - 60000).toISOString() : null }).eq('id', id))
    await unwrap(f.admin.from('booking_payments').update({ method, status: paymentStatus, paid_at: paymentStatus === 'paid' ? new Date().toISOString() : null, verified_at: null, verified_by: null }).eq('booking_id', id))
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
