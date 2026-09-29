export function formatPostcode(value = '') {
  const compact = value.toUpperCase().replace(/\s+/g, '')
  return /^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$/.test(compact) || compact === 'GIR0AA'
    ? `${compact.slice(0, -3)} ${compact.slice(-3)}` : value.toUpperCase().trim()
}
export function paymentStatus(booking) {
  if (booking.reservation_expired) return 'Reservation expired'
  return ({ awaiting_transfer: 'Awaiting your bank transfer', awaiting_verification: "Transfer sent — I'll check it shortly",
    awaiting_approval: 'Cash on arrival', approved: 'Cash on arrival', paid: 'Payment received',
    rejected: 'Payment request declined', refunded: 'Payment refunded' })[booking.booking_payments.status] || 'Contact Vad for a payment update'
}
