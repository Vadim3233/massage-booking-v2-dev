import { supabase } from '../lib/supabase.js'
import { hasStarted, money, today } from './calendarPresentation.js'

// "Remove travel fee" on a booking already made (20261225100000_remove_travel_fee.sql). Only the Admin, on a booking still to happen.
// The money follows the Edit booking rules: not paid yet, the amount to pay drops; paid, it first comes off any extra still to pay, then the
// rest is a refund to send. Money the client says they sent is checked first.

export const STILL_TO_HAPPEN = ['awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed']
const paymentOf = booking => (Array.isArray(booking?.booking_payments) ? booking.booking_payments[0] : booking?.booking_payments) || null
const cents = value => Math.round(Number(value || 0) * 100)

// Why the travel fee cannot come off, in Vadim's words, or '' when it can. null when the button should not show at all.
export function travelFeeBlock(booking, now = new Date()) {
  if (!booking || cents(booking.travel_fee_gbp) <= 0 || !STILL_TO_HAPPEN.includes(booking.booking_status) || hasStarted(booking, now)) return null
  const payment = paymentOf(booking)
  if (!payment || ['rejected', 'refunded'].includes(payment.status)) return null
  if (payment.status === 'awaiting_verification') return 'The client says they sent the transfer. Once the money is in your bank, press Mark paid above, then remove the travel fee.'
  if (booking.balance_reported_at && cents(booking.balance_due_gbp) > 0) return 'The client says they sent the extra still to pay. Mark it received first, then remove the travel fee.'
  const fee = cents(booking.travel_fee_gbp)
  const gift = cents(booking.gift_covered_gbp)
  const total = cents(booking.total_gbp) - fee
  const fromBalance = payment.status === 'paid' ? Math.min(cents(booking.balance_due_gbp), fee) : 0
  const amount = cents(payment.amount_gbp) - (payment.status === 'paid' ? fee - fromBalance : fee)
  const balance = cents(booking.balance_due_gbp) - fromBalance
  if (total - gift <= 0 || amount < 0 || (gift > 0 && amount + balance <= 0)) return 'Without the travel fee there would be nothing left to pay. Please change this booking by hand.'
  return ''
}
export const canRemoveTravelFee = (booking, now = new Date()) => travelFeeBlock(booking, now) === ''

// What removing it does to the money, said before Vadim confirms.
export function travelFeeOutcome(booking) {
  const payment = paymentOf(booking)
  const fee = cents(booking.travel_fee_gbp)
  const total = (cents(booking.total_gbp) - fee) / 100
  const price = `The price goes from ${money(booking.total_gbp)} to ${money(total)}.`
  if (!payment || payment.status !== 'paid') {
    return { refund: 0, text: `${price} The client then pays ${money((cents(payment?.amount_gbp) - fee) / 100)}${payment?.method === 'cash' ? ' in cash' : ''}.` }
  }
  const fromBalance = Math.min(cents(booking.balance_due_gbp), fee)
  const refund = (fee - fromBalance) / 100
  const parts = [price]
  if (fromBalance > 0) parts.push(`${money(fromBalance / 100)} comes off what they still had to pay.`)
  if (refund > 0) parts.push(`They have already paid, so ${money(refund)} shows as a refund to send until you press Record refund sent.`)
  const note = Number(booking.gift_covered_gbp) > 0 ? ' If the gift voucher paid for the travel, it stays.' : ''
  return { refund, text: parts.join(' ') + note }
}

const SAFE = new Set([
  'The travel fee can only be removed from a booking still to happen.',
  'The appointment has already started, so its travel fee stays.',
  'This booking has no travel fee.',
  'This booking has no payment to change.',
  'The gift voucher already paid for the travel on this booking, so the travel fee stays.',
  'Without the travel fee there would be nothing left to pay. Please change this booking by hand.',
  'The client says they sent the transfer. Check it first (Mark received), then remove the travel fee.',
  'The client says they sent the extra still to pay. Mark it received first, then remove the travel fee.',
])
// The database's own words (20261225100000) name the button as it was first written; the screen shows the button's real name.
const SHOWN = { 'The client says they sent the transfer. Check it first (Mark received), then remove the travel fee.': 'The client says they sent the transfer. Once the money is in your bank, press Mark paid above, then remove the travel fee.' }
function failure(error) {
  const conflict = ['PT409', '40001'].includes(error?.code) && !SAFE.has(error?.message)
  const result = new Error(SAFE.has(error?.message) ? SHOWN[error.message] || error.message
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
        .select('id,date,start_minutes,updated_at,booking_status,total_gbp,travel_fee_gbp,congestion_fee_gbp,gift_covered_gbp,gift_voucher_id,balance_due_gbp,balance_reported_at,service_area_name_snapshot,booking_payments(method,status,amount_gbp)')
        .eq('client_id', clientId).gt('travel_fee_gbp', 0).in('booking_status', STILL_TO_HAPPEN).gte('date', today())
        .order('date').order('start_minutes')
      if (error) throw new Error('Could not load their upcoming bookings. Please try again.')
      return (data || []).filter(booking => travelFeeBlock(booking, now) !== null)
    },
  }
}
export const travelFeeApi = createTravelFeeApi(supabase)
