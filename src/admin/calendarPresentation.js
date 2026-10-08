export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
export function shiftDate(date, days) { const value = new Date(date + 'T12:00:00Z'); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10) }
export const time = (minutes) => `${Math.floor(minutes / 60).toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}`
export const money = (value) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(value)
export const label = (value) => ({ awaiting_transfer: 'Awaiting transfer', awaiting_payment_verification: 'Awaiting payment verification', awaiting_cash_approval: 'Awaiting cash approval', awaiting_verification: 'Awaiting verification', awaiting_approval: 'Awaiting approval', bank_transfer: 'Bank transfer', no_show: 'No show' }[value] || (value ? value[0].toUpperCase() + value.slice(1).replaceAll('_', ' ') : 'Not recorded'))
export const postcode = (value) => (value || '').replace(/\s/g, '').toUpperCase().replace(/(.+)(.{3})$/, '$1 $2')
export const clientName = (booking) => [booking.clients?.first_name, booking.clients?.last_name].filter(Boolean).join(' ') || 'Client unavailable'
export function dayContext(data, date, now) {
  const hours = data.overrides.find(row => row.date === date) || data.hours.find(row => row.weekday === (new Date(date + 'T12:00:00Z').getUTCDay() || 7))
  const holds = data.holds.filter(row => Date.parse(row.expires_at) > now)
  if (!hours?.available) return { hours, holds, gaps: [] }
  const occupied = [...data.blocks.map(row => [row.start_minutes, row.end_minutes]), ...data.bookings.filter(row => ['confirmed', 'completed', 'awaiting_payment_verification', 'awaiting_cash_approval', 'awaiting_transfer'].includes(row.booking_status)).map(row => [row.start_minutes - row.travel_buffer_minutes, row.start_minutes + row.treatment_duration_minutes + row.travel_buffer_minutes]), ...holds.map(row => [row.start_minutes - row.travel_buffer_minutes, row.start_minutes + row.treatment_duration_minutes + row.travel_buffer_minutes])].sort((a, b) => a[0] - b[0])
  const gaps = []; let cursor = hours.start_minutes
  for (const [start, end] of occupied) { if (start > cursor) gaps.push([cursor, Math.min(start, hours.end_minutes)]); cursor = Math.max(cursor, end); if (cursor >= hours.end_minutes) break }
  if (cursor < hours.end_minutes) gaps.push([cursor, hours.end_minutes])
  return { hours, holds, gaps }
}

export const dateLabel = (date, options = { weekday: 'short', day: 'numeric', month: 'short' }) => new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'Europe/London' }).format(new Date(date + 'T12:00:00Z'))
export function sessionSummary(booking) {
  const sessions = booking.booking_sessions || []
  if (sessions.length === 1) return `${sessions[0].service_name_snapshot} · ${sessions[0].duration_minutes} min`
  return `${sessions.length} sessions · ${booking.treatment_duration_minutes} min`
}
export function bookingState(booking) {
  if (booking.booking_status === 'cancelled') return { text: 'Cancelled', tone: 'cancelled' }
  const payment = booking.booking_payments?.status
  if (booking.booking_status === 'awaiting_payment_verification' || payment === 'awaiting_verification') return { text: 'Awaiting payment verification', tone: 'pending' }
  if (booking.booking_status === 'awaiting_cash_approval' || payment === 'awaiting_approval') return { text: 'Awaiting cash approval', tone: 'pending' }
  if (booking.booking_status === 'awaiting_transfer') return { text: 'Awaiting transfer', tone: 'pending' }
  const paymentText = payment === 'approved' && booking.booking_payments?.method === 'cash' ? 'Cash approved' : label(payment)
  return { text: `${label(booking.booking_status)} · ${paymentText}`, tone: ['confirmed', 'completed'].includes(booking.booking_status) ? 'confirmed' : 'muted' }
}

// Presentation only: use the existing occupied intervals and persisted buffers.
// Free intervals are context, not available slots or measured journey times.
export function dayTimeline(data, date, now) {
  const context = dayContext(data, date, now)
  const rows = []
  const add = (kind, id, start, end, extra = {}) => rows.push({ kind, id, start, end, ...extra })
  const bufferIntervals = []
  function buffers(row) {
    const buffer = Number(row.travel_buffer_minutes) || 0
    if (buffer <= 0) return
    const end = row.start_minutes + row.treatment_duration_minutes
    bufferIntervals.push([Math.max(0, row.start_minutes - buffer), row.start_minutes])
    bufferIntervals.push([end, Math.min(1440, end + buffer)])
  }
  for (const booking of data.bookings) {
    add('booking', booking.id, booking.start_minutes, booking.start_minutes + booking.treatment_duration_minutes, { booking })
    if (['confirmed', 'completed', 'awaiting_payment_verification', 'awaiting_cash_approval', 'awaiting_transfer'].includes(booking.booking_status)) buffers(booking)
  }
  for (const block of data.blocks) add('block', block.id, block.start_minutes, block.end_minutes, { title: block.title || 'Blocked time' })
  for (const hold of context.holds) {
    add('hold', hold.id, hold.start_minutes, hold.start_minutes + hold.treatment_duration_minutes)
    buffers(hold)
  }
  // Normalize display intervals only; dayContext remains authoritative for free time.
  const mergedBuffers = []
  for (const [start, end] of bufferIntervals.sort((a, b) => a[0] - b[0])) {
    if (end <= start) continue
    const previous = mergedBuffers.at(-1)
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end)
    else mergedBuffers.push([start, end])
  }
  for (const [start, end] of mergedBuffers) add('buffer', `buffer-${start}-${end}`, start, end)
  if (context.hours?.available) {
    for (const [start, end] of context.gaps) {
      // Cancelled bookings stay visible without taking time out of free gaps.
      const cuts = [...new Set([start, end, ...data.bookings.flatMap(b => [b.start_minutes, b.start_minutes + b.treatment_duration_minutes]).filter(value => value > start && value < end)])].sort((a, b) => a - b)
      for (let i = 1; i < cuts.length; i++) add('free', `free-${cuts[i - 1]}`, cuts[i - 1], cuts[i])
    }
  }
  const order = { booking: 1, block: 2, hold: 3, buffer: 4, free: 5 }
  return { ...context, rows: rows.sort((a, b) => a.start - b.start || order[a.kind] - order[b.kind]) }
}
