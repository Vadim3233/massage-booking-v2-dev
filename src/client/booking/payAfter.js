import { dayParts } from './dateStrip.js'

// Booking several sessions: a client pays for one at a time. A later session is paid after the session before it (ADR-097).

// "Thu 12 Nov", the way the booking pill names a day.
export function sessionDay(date) {
  const { weekday, day, month } = dayParts(date)
  return `${weekday} ${day} ${month}`
}

// "12 Nov", for the short lines in lists and on buttons.
export function shortDay(date) {
  const { day, month } = dayParts(date)
  return `${day} ${month}`
}

// The earlier session a booking still at the payment step could be paid after, or null. Not for cash, nor while Vadim checks the address.
export function payAfterChoice(booking, cash) {
  if (cash || !booking || booking.area_check || booking.pay_after_session) return null
  return booking.earlier_session || null
}
