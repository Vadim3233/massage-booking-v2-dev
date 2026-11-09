import { supabase } from '../lib/supabase.js'
import { createAdminGate } from './adminGate.js'

const fields = `*,clients!bookings_client_id_fkey(id,first_name,last_name,email,phone),
booking_sessions(*,booking_session_preferences(*),booking_session_enhancements(*)),
booking_payments(*),booking_enhancements(*)`
const queueFields = `id,client_id,booking_reference,date,start_minutes,treatment_duration_minutes,total_gbp,booking_status,created_at,updated_at,
clients!bookings_client_id_fkey(id,first_name,last_name,phone),booking_sessions(service_name_snapshot,duration_minutes),
booking_payments(method,status,updated_at,amount_gbp,payment_reference)`
// What needs the Admin right now: transfers the client says they made, cash requests to decide, and an appointment that has happened
// without the payment being received yet.
export const NEEDS_YOU = ['awaiting_verification', 'awaiting_approval']
const londonClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
function londonNow(now) {
  const parts = Object.fromEntries(londonClock.formatToParts(now).map(part => [part.type, part.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) }
}
// A confirmed booking whose appointment has finished, with the bank transfer not received or the cash not marked received.
export function paymentOverdue(booking, now = Date.now()) {
  const payment = booking.booking_payments
  if (!['confirmed', 'completed'].includes(booking.booking_status) || !payment) return false
  const unpaid = (payment.method === 'bank_transfer' && ['awaiting_transfer', 'awaiting_verification'].includes(payment.status)) || (payment.method === 'cash' && payment.status === 'approved')
  if (!unpaid || !booking.date) return false
  const clock = londonNow(now)
  const ends = Number(booking.start_minutes) + Number(booking.treatment_duration_minutes || 0)
  return booking.date < clock.date || (booking.date === clock.date && ends <= clock.minutes)
}
export const needsYou = booking => NEEDS_YOU.includes(booking.booking_payments?.status) || paymentOverdue(booking)
export const paymentActions = booking => {
  const payment = booking.booking_payments
  // A booking waiting for payment is never cancelled automatically: the Admin confirms the payment, confirms the booking with the payment
  // still to come ("Confirm, pay later"), or removes it.
  if (booking.booking_status === 'awaiting_transfer' && payment?.method === 'bank_transfer' && payment.status === 'awaiting_transfer') return ['verify', 'payLater', 'remove']
  if (booking.booking_status === 'awaiting_payment_verification' && payment?.method === 'bank_transfer' && payment.status === 'awaiting_verification') return ['verify', 'payLater', 'remove']
  if (booking.booking_status === 'awaiting_cash_approval' && payment?.method === 'cash' && payment.status === 'awaiting_approval') return ['approve', 'remove']
  if (['confirmed', 'completed'].includes(booking.booking_status) && payment?.method === 'cash' && payment.status === 'approved') return ['receive']
  if (['confirmed', 'completed'].includes(booking.booking_status) && payment?.method === 'bank_transfer' && ['awaiting_transfer', 'awaiting_verification'].includes(payment.status)) return ['receiveBank']
  return []
}
// How a confirmed booking is paid can be changed (bank transfer to cash, or back), whether or not it has been paid yet: a client may have picked
// the wrong one, or paid at the door. A paid booking stays paid and its receipt is corrected; a rejected or refunded payment is left alone.
export const methodSwitch = booking => {
  const payment = booking.booking_payments
  if (!['confirmed', 'completed'].includes(booking.booking_status) || !payment) return null
  if (payment.method === 'bank_transfer' && ['awaiting_transfer', 'awaiting_verification', 'paid'].includes(payment.status)) return 'toCash'
  if (payment.method === 'cash' && ['approved', 'paid'].includes(payment.status)) return 'toBank'
  return null
}
export const actionLabels = { verify: 'Verify payment', payLater: 'Confirm, pay later', approve: 'Approve', remove: 'Cancel unpaid booking', receive: 'Mark payment received', receiveBank: 'Mark paid', toCash: 'Change to cash', toBank: 'Change to bank transfer' }
const operations = { verify: 'admin_verify_bank_transfer', payLater: 'admin_confirm_pay_later', approve: 'admin_approve_cash_request', remove: 'admin_remove_pending_booking', receive: 'admin_record_payment_received', receiveBank: 'admin_record_bank_transfer_received', toCash: 'admin_switch_payment_method', toBank: 'admin_switch_payment_method' }
const methods = { toCash: 'cash', toBank: 'bank_transfer' }
export function createPaymentReviewApi(client) {
  const authorized = createAdminGate(client, { signedOut: 'Admin sign-in required.', denied: 'Admin access required.' })
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
        p_booking_updated_at: booking.updated_at, p_payment_updated_at: booking.booking_payments.updated_at, ...(methods[action] && { p_method: methods[action] }) })
      if (error) {
        const failure = new Error(['PT409', '40001'].includes(error.code) ? 'This booking changed before you could finish, so it has been reloaded. Please check it and try again.' : 'Could not complete the payment action. Refresh the booking before trying again.')
        failure.conflict = ['PT409', '40001'].includes(error.code)
        throw failure
      }
    },
  }
}
export const paymentReviewApi = createPaymentReviewApi(supabase)
// Identical reads share one answer: StrictMode's repeated effects, and the To check count and the Payment review page asking for
// the same list as the page opens. An answer is kept for `keepMs` after it arrives; a failure is never kept.
const pending = new Map()
export function loadReviewResource(key, read, keepMs = 0) {
  if (pending.has(key)) return pending.get(key)
  const promise = read()
  const forget = () => { if (pending.get(key) === promise) pending.delete(key) }
  promise.then(() => setTimeout(forget, keepMs), forget)
  pending.set(key, promise)
  return promise
}
