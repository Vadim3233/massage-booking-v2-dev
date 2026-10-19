export function paymentStatus(booking) {
  return ({ awaiting_transfer: 'Awaiting your bank transfer', awaiting_verification: "Transfer sent — I'll check it shortly",
    awaiting_approval: 'Cash on arrival', approved: 'Cash on arrival', paid: 'Payment received',
    rejected: 'No payment taken', refunded: 'Payment refunded' })[booking.booking_payments.status] || 'Contact Vad for a payment update'
}
