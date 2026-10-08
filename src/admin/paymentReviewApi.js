import { supabase } from '../lib/supabase.js'

const fields = `*,clients!bookings_client_id_fkey(id,first_name,last_name,email,phone),
booking_sessions(*,booking_session_preferences(*),booking_session_enhancements(*)),
booking_payments(*),booking_enhancements(*)`
const queueFields = `id,booking_reference,date,start_minutes,treatment_duration_minutes,total_gbp,booking_status,created_at,updated_at,
clients!bookings_client_id_fkey(first_name,last_name),booking_sessions(service_name_snapshot,duration_minutes),
booking_payments(method,status,updated_at)`
export const paymentActions = booking => {
  const payment = booking.booking_payments
  // A booking waiting for payment is never cancelled automatically: the Admin confirms the payment or removes it.
  if (booking.booking_status === 'awaiting_transfer' && payment?.method === 'bank_transfer' && payment.status === 'awaiting_transfer') return ['verify', 'remove']
  if (booking.booking_status === 'awaiting_payment_verification' && payment?.method === 'bank_transfer' && payment.status === 'awaiting_verification') return ['verify', 'remove']
  if (booking.booking_status === 'awaiting_cash_approval' && payment?.method === 'cash' && payment.status === 'awaiting_approval') return ['approve', 'remove']
  if (['confirmed', 'completed'].includes(booking.booking_status) && payment?.method === 'cash' && payment.status === 'approved') return ['receive']
  return []
}
export const actionLabels = { verify: 'Verify payment', approve: 'Approve', remove: 'Remove booking', receive: 'Mark payment received' }
const operations = { verify: 'admin_verify_bank_transfer', approve: 'admin_approve_cash_request', remove: 'admin_remove_pending_booking', receive: 'admin_record_payment_received' }
export function createPaymentReviewApi(client) {
  async function authorized() {
    const user = await client.auth.getUser()
    if (user.error || !user.data.user || user.data.user.is_anonymous) throw new Error('Admin sign-in required.')
    const result = await client.rpc('is_booking_admin')
    if (result.error || !result.data) throw new Error('Admin access required.')
  }
  return {
    async queue(offset = 0) {
      await authorized()
      const { data, error } = await client.rpc('admin_payment_review_queue', { p_offset: offset }).select(queueFields)
      if (error) throw new Error('Could not load payment reviews. Please retry.')
      return { bookings: data.slice(0, 50), hasMore: data.length > 50 }
    },
    async booking(id) {
      await authorized()
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Booking not found.')
      const { data, error } = await client.from('bookings').select(fields).eq('id', id).maybeSingle()
      if (error) throw new Error('Could not load booking. Please retry.')
      if (!data) throw new Error('Booking not found.')
      return data
    },
    async act(action, booking, requestId) {
      if (!operations[action]) throw new Error('Action unavailable.')
      const { error } = await client.rpc(operations[action], { p_booking_id: booking.id, p_request_id: requestId,
        p_booking_updated_at: booking.updated_at, p_payment_updated_at: booking.booking_payments.updated_at })
      if (error) {
        const failure = new Error(['PT409', '40001'].includes(error.code) ? 'This booking changed before the action was completed. Refreshing its current status.' : 'Could not complete the payment action. Refresh the booking before trying again.')
        failure.conflict = ['PT409', '40001'].includes(error.code)
        throw failure
      }
    },
  }
}
export const paymentReviewApi = createPaymentReviewApi(supabase)
// Deduplicate StrictMode's initial reads; entries exist only while a request is pending.
const pending = new Map()
export function loadReviewResource(key, read) {
  if (!pending.has(key)) pending.set(key, read().finally(() => pending.delete(key)))
  return pending.get(key)
}
