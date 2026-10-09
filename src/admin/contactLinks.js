// Quick contact links for a booking. Phone numbers are stored as typed, so they are normalised for WhatsApp.
export function whatsappNumber(phone) {
  if (!phone) return null
  const trimmed = String(phone).trim()
  let digits = trimmed.replace(/[^0-9]/g, '')
  if (!digits) return null
  if (trimmed.startsWith('+')) return digits
  if (digits.startsWith('00')) return digits.slice(2)
  if (digits.startsWith('0')) return `44${digits.slice(1)}`
  return digits
}

export function contactLinks(booking) {
  const phone = booking.clients?.phone
  const email = booking.booking_email_snapshot || booking.clients?.email
  const number = whatsappNumber(phone)
  const address = [booking.address_line_1_snapshot, booking.address_line_2_snapshot, booking.city_snapshot, booking.postcode_snapshot].filter(Boolean).join(', ')
  return [
    phone && { key: 'call', label: 'Call', href: `tel:${String(phone).replace(/[^0-9+]/g, '')}` },
    number && { key: 'whatsapp', label: 'WhatsApp', href: `https://wa.me/${number}`, external: true },
    address && { key: 'directions', label: 'Directions', href: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`, external: true },
    email && { key: 'email', label: 'Email', href: `mailto:${email}` },
  ].filter(Boolean)
}

export function clientContactLinks(client) {
  const number = whatsappNumber(client.phone)
  return [
    client.phone && { key: 'call', label: 'Call', href: `tel:${String(client.phone).replace(/[^0-9+]/g, '')}` },
    number && { key: 'whatsapp', label: 'WhatsApp', href: `https://wa.me/${number}`, external: true },
    client.email && { key: 'email', label: 'Email', href: `mailto:${client.email}` },
  ].filter(Boolean)
}
