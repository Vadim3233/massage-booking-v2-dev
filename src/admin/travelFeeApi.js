import { supabase } from '../lib/supabase.js'
import { hasStarted, money, today } from './calendarPresentation.js'

// "Remove travel fee" on a booking already made (20261225100000_remove_travel_fee.sql). Only the Admin, on a booking still to happen.
// The money follows the Edit booking rules: not paid yet, the amount to pay drops; paid or sent, it first comes off anything still to pay,
// then the rest is a refund to send.

export const STILL_TO_HAPPEN = ['awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed']
const HELD = ['paid', 'awaiting_verification']
const paymentOf = booking => (Array.isArray(booking?.booking_payments) ? booking.booking_payments[0] : booking?.booking_payments) || null
const cents = value => Math.round(Number(value || 0) * 100)

// Why the travel fee cannot come off, in Vadim's words, or '' when it can. null when the button should not show at all.
export function travelFeeBlock(booking, now = new Date()) {
  if (!booking || cents(booking.travel_fee_gbp) <= 0 || !STILL_TO_HAPPEN.includes(booking.booking_status) || hasStarted(booking, now)) return null
  const payment = paymentOf(booking)
  if (!payment || ['rejected', 'refunded'].includes(payment.status)) return null
  const total = cents(booking.total_gbp) - cents(booking.travel_fee_gbp)
  if (cents(booking.gift_covered_gbp) > total) return 'The gift voucher already paid for the travel on this booking, so the travel fee stays.'
  if (!HELD.includes(payment.status) && cents(payment.amount_gbp) - cents(booking.travel_fee_gbp) <= 0) return 'Without the travel fee there would be nothing left to pay. Please change this booking by hand.'
  return ''
}
export const canRemoveTravelFee = (booking, now = new Date()) => travelFeeBlock(booking, now) === ''

// What removing it does to the money, said before Vadim confirms.
export function travelFeeOutcome(booking) {
  const payment = paymentOf(booking)
  const fee = cents(booking.travel_fee_gbp)
  const total = (cents(booking.total_gbp) - fee) / 100
  const price = `The price goes from ${money(booking.total_gbp)} to ${money(total)}.`
  if (!payment || !HELD.includes(payment.status)) {
    return { refund: 0, text: `${price} The client then pays ${money((cents(payment?.amount_gbp) - fee) / 100)}${payment?.method === 'cash' ? ' in cash' : ''}.` }
  }
  const fromBalance = Math.min(cents(booking.balance_due_gbp), fee)
  const refund = (fee - fromBalance) / 100
  const said = payment.status === 'paid' ? 'They have already paid' : 'They say they have sent the money'
  const parts = [price]
  if (fromBalance > 0) parts.push(`${money(fromBalance / 100)} comes off what they still had to pay.`)
  if (refund > 0) parts.push(`${said}, so ${money(refund)} shows as a refund to send until you press Record refund sent.`)
  return { refund, text: parts.join(' ') }
}

const SAFE = new Set([
  'The travel fee can only be removed from a booking still to happen.',
  'The appointment has already started, so its travel fee stays.',
  'This booking has no travel fee.',
  'This booking has no payment to change.',
  'The gift voucher already paid for the travel on this booking, so the travel fee stays.',
  'Without the travel fee there would be nothing left to pay. Please change this booking by hand.',
])
function failure(error) {
  const conflict = ['PT409', '40001'].includes(error?.code) && !SAFE.has(error?.message)
  const result = new Error(SAFE.has(error?.message) ? error.message
    : conflict ? 'This booking changed before you could finish, so it has been reloaded. Please check it and try again.'
      : 'Could not remove the travel fee. Please check your connection and try again.')
  result.conflict = conflict
  return result
}

export function createTravelFeeApi(client) {
  return {
    async remove(booking, requestId, notify = true) {
      const { data, error } = await client.rpc('admin_remove_travel_fee', {
        p_booking_id: booking.id, p_request_id: requestId, p_booking_updated_at: booking.updated_at, p_notify_client: Boolean(notify) })
      if (error) throw failure(error)
      return data
    },
    // A client's bookings still to happen that have a travel fee, soonest first.
    async upcoming(clientId, now = new Date()) {
      const { data, error } = await client.from('bookings')
        .select('id,date,start_minutes,updated_at,booking_status,total_gbp,travel_fee_gbp,gift_covered_gbp,balance_due_gbp,service_area_name_snapshot,booking_payments(method,status,amount_gbp)')
        .eq('client_id', clientId).gt('travel_fee_gbp', 0).in('booking_status', STILL_TO_HAPPEN).gte('date', today())
        .order('date').order('start_minutes')
      if (error) throw new Error('Could not load their upcoming bookings. Please try again.')
      return (data || []).filter(booking => travelFeeBlock(booking, now) !== null)
    },
  }
}
export const travelFeeApi = createTravelFeeApi(supabase)
