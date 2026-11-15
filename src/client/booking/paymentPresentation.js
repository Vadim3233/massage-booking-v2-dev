import { shortDay } from './payAfter.js'

export function paymentStatus(booking) {
  // A later session paid after the client's earlier one (ADR-097) is not waiting for a transfer yet.
  if (booking.booking_payments.status === 'awaiting_transfer' && booking.pay_after_session) return `To pay after your ${shortDay(booking.pay_after_session.date)} session`
  // Paid in full by a gift voucher (ADR-101).
  if (booking.booking_payments.status === 'paid' && Number(booking.gift_covered_gbp) > 0 && Number(booking.booking_payments.amount_gbp) === 0) return 'Paid by gift voucher'
  return ({ awaiting_transfer: 'Awaiting your bank transfer', awaiting_verification: "Transfer sent — I'll check it shortly",
    awaiting_approval: 'Cash on arrival', approved: 'Cash on arrival', paid: 'Payment received',
    rejected: 'No payment taken', refunded: 'Payment refunded' })[booking.booking_payments.status] || 'Contact Vadim for a payment update'
}
