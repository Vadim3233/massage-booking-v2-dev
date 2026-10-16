import { useCallback, useState } from 'react'
import { londonMoment } from '../lib/londonMoment.js'
import { money } from './calendarPresentation.js'

// Cancelled bookings are history, so the Admin's lists leave them out unless the Admin asks for them ("Show cancelled" in the Agenda, kept on this
// device). The one exception is a cancelled booking with money still to sort out, which stays listed until it is dealt with, so a refund to
// send or a late fee to collect cannot be forgotten just because the booking is cancelled.
export const SHOW_CANCELLED_KEY = 'vad-admin-agenda-show-cancelled'

// What is still owed on a cancelled booking, in words ("refund £90.00 to send"), or nothing. The two conditions are the ones that offer the
// Admin the actions that settle them (record the refund, mark the fee received or waived), so a flag always has a way to clear it.
export function moneyToSort(booking) {
  if (booking?.booking_status !== 'cancelled') return ''
  const payment = Array.isArray(booking.booking_payments) ? booking.booking_payments[0] : booking.booking_payments
  const owed = []
  if (payment?.status === 'paid' && Number(booking.refund_due_gbp) > 0) owed.push(`refund ${money(booking.refund_due_gbp)} to send`)
  if (booking.late_fee_status === 'due') owed.push(`late fee ${money(booking.late_fee_due_gbp)} due`)
  return owed.join(' · ')
}

// Who cancelled a booking and when, in a few words for its card ("by client · Wed 14 Oct, 18:20", London time), so a late cancellation can be
// told from an early one without opening the booking. Nothing for a booking that is not cancelled or whose time was never recorded.
const CANCELLED_BY = { client: 'by client', admin: 'by you', system: 'automatically' }
export function cancelledNote(booking, now = new Date()) {
  const moment = booking?.booking_status === 'cancelled' ? londonMoment(booking.cancelled_at, { now }) : null
  if (!moment) return ''
  return [CANCELLED_BY[booking.cancelled_by_actor_type], `${moment.day}, ${moment.time}`].filter(Boolean).join(' · ')
}

// Whether the Admin's lists show this booking: anything that is not cancelled, a cancelled booking with money to sort out, and every cancelled
// booking when the Admin has asked to see them.
export const isListed = (booking, showCancelled) => showCancelled || booking.booking_status !== 'cancelled' || Boolean(moneyToSort(booking))
export const listedBookings = (bookings, showCancelled) => showCancelled ? bookings : bookings.filter(booking => isListed(booking, false))
// How many of these bookings the switch hides when it is off (the cancelled ones with nothing left to sort out).
export const hiddenCancelled = bookings => bookings.filter(booking => !isListed(booking, false)).length

export function readShowCancelled() {
  try { return localStorage.getItem(SHOW_CANCELLED_KEY) === '1' } catch { return false }
}
export function writeShowCancelled(on) {
  try { localStorage.setItem(SHOW_CANCELLED_KEY, on ? '1' : '0') } catch { /* A convenience only: a phone that will not keep it is not told. */ }
}

// The choice as a piece of state: it starts as the Admin left it on this device and is kept whenever it is changed.
export function useShowCancelled() {
  const [on, setOn] = useState(readShowCancelled)
  const change = useCallback(value => { setOn(value); writeShowCancelled(value) }, [])
  return [on, change]
}
