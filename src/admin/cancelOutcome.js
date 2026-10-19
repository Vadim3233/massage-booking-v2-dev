import { money } from './calendarPresentation.js'

// What cancelling does to the money, said in plain words before it is done. It follows the database's own rule (admin_cancel_booking): a booking that has
// been paid keeps the fee and the rest becomes a refund for the Admin to send; a booking not paid has nothing to refund, and a fee on it is recorded as
// due. This is the one place the screens say it; a browser test checks the refund the database records is the one said here.
export function cancelOutcome(booking, fee) {
  const first = booking.clients?.first_name?.trim() || 'The client'
  const payment = Array.isArray(booking.booking_payments) ? booking.booking_payments[0] : booking.booking_payments
  const charged = Math.max(0, Number(fee) || 0)
  if (payment?.status === 'paid') {
    const paid = Number(payment.amount_gbp)
    const kept = Math.min(charged, paid)
    const refund = Math.max(paid - charged, 0)
    if (kept === 0) return { text: `No cancellation fee – ${first} gets a full ${money(paid)} refund`, refund }
    if (refund === 0) return { text: `Late cancellation – you keep the full ${money(paid)}, nothing to refund`, refund }
    return { text: `Late cancellation – you keep ${money(kept)}, refund ${money(refund)}`, refund }
  }
  if (charged > 0) return { text: `No money has been paid – nothing to refund. A late fee of ${money(charged)} is recorded as due`, refund: 0 }
  return { text: 'No money has been paid – nothing to refund', refund: 0 }
}

// Said under the outcome when there is a refund: the app records it, the Admin sends it.
export const REFUND_HINT = 'You send it yourself, then press Record refund.'
