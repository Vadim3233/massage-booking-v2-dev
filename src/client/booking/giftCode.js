// Booking with a gift voucher (ADR-101): the voucher's link (/?gift=7K3M-QX9P) or its code typed in. The database checks the code and works out
// what the voucher pays (20261214100000_gift_vouchers.sql); this only carries the code through the booking pages.

// The code in the address, as the database keeps it (letters and digits only), or null.
export function giftCodeFromSearch(search) {
  const raw = new URLSearchParams(search || '').get('gift')
  const code = (raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  return /^[A-Z0-9]{8}$/.test(code) ? code : null
}
export const cleanGiftCode = text => String(text || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()

// What the draft keeps of a voucher the database says can be used.
export const giftFromRow = (code, row) => ({
  code, minutes: Number(row.minutes), people: Number(row.people), from: row.from_name, to: row.recipient_name,
  travel: row.travel_choice, area: row.area_name || null, cover: Number(row.travel_cover || 0), expires: row.expires_at,
})

// The voucher's sessions: its length for each of its people.
export const giftSessions = (gift, make) => Array.from({ length: gift.people }, () => make(gift.minutes))

// The money lines a voucher adds under the price, from the database's quote.
export function giftLines(quote) {
  if (!quote || quote.gift_covered_gbp == null) return null
  return { covered: Number(quote.gift_covered_gbp), toPay: Number(quote.to_pay_gbp) }
}
