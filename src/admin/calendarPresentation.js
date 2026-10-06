export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
export function shiftDate(date, days) { const value = new Date(date + 'T12:00:00Z'); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10) }
export const time = (minutes) => `${Math.floor(minutes / 60).toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}`
export const money = (value) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(value)
export const label = (value) => ({ awaiting_transfer: 'Awaiting transfer', awaiting_payment_verification: 'Awaiting payment verification', awaiting_cash_approval: 'Awaiting cash approval', awaiting_verification: 'Awaiting verification', awaiting_approval: 'Awaiting approval', bank_transfer: 'Bank transfer', no_show: 'No show' }[value] || (value ? value[0].toUpperCase() + value.slice(1).replaceAll('_', ' ') : 'Not recorded'))
export const postcode = (value) => (value || '').replace(/\s/g, '').toUpperCase().replace(/(.+)(.{3})$/, '$1 $2')
export const clientName = (booking) => [booking.clients?.first_name, booking.clients?.last_name].filter(Boolean).join(' ') || 'Client unavailable'
export const expired = (booking, now) => booking.booking_status === 'awaiting_transfer' && Date.parse(booking.payment_reservation_expires_at) <= now
export function dayContext(data, date, now) {
  const hours = data.overrides.find(row => row.date === date) || data.hours.find(row => row.weekday === (new Date(date + 'T12:00:00Z').getUTCDay() || 7))
  const holds = data.holds.filter(row => Date.parse(row.expires_at) > now)
  if (!hours?.available) return { hours, holds, gaps: [] }
  const occupied = [...data.blocks.map(row => [row.start_minutes, row.end_minutes]), ...data.bookings.filter(row => ['confirmed', 'completed', 'awaiting_payment_verification', 'awaiting_cash_approval', 'awaiting_transfer'].includes(row.booking_status) && !expired(row, now)).map(row => [row.start_minutes - row.travel_buffer_minutes, row.start_minutes + row.treatment_duration_minutes + row.travel_buffer_minutes]), ...holds.map(row => [row.start_minutes - row.travel_buffer_minutes, row.start_minutes + row.treatment_duration_minutes + row.travel_buffer_minutes])].sort((a, b) => a[0] - b[0])
  const gaps = []; let cursor = hours.start_minutes
  for (const [start, end] of occupied) { if (start > cursor) gaps.push([cursor, Math.min(start, hours.end_minutes)]); cursor = Math.max(cursor, end); if (cursor >= hours.end_minutes) break }
  if (cursor < hours.end_minutes) gaps.push([cursor, hours.end_minutes])
  return { hours, holds, gaps }
}
