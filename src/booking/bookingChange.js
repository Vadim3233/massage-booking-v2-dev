// Changing a booking: who is coming, treatments and lengths (Vadim's rules, 11 Nov 2026; migration 20261204100000_edit_booking_services.sql).
// The database works out the price and the money (booking_change_plan) and the screens show its answer; these helpers only turn a booking
// into people to edit, the people back into what the database is sent, and its answer into plain words. Used by the Admin and by clients.
import { MAX_PEOPLE, MAX_VISIT_MINUTES } from './bookingWords.js'

export const LENGTHS = [60, 90, 120]
export const CHANGEABLE = ['awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed']
const money = amount => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(amount)

// The booking's people, in order, as they can be edited. `id` ties each one to the session it was, so an unchanged person keeps their price.
export function peopleFromBooking(booking) {
  return [...(booking.booking_sessions || [])].sort((a, b) => a.position - b.position).map(session => ({
    id: session.id, service_id: session.service_id, duration_minutes: session.duration_minutes,
    recipient_name: session.recipient_name || '', name: session.service_name_snapshot,
  }))
}

// Another person: the same treatment as the first, for an hour.
export const newPerson = people => ({ id: null, service_id: people[0]?.service_id || null, duration_minutes: 60, recipient_name: '', name: people[0]?.name || '' })

export const totalMinutes = people => people.reduce((sum, person) => sum + Number(person.duration_minutes || 0), 0)

// Can one more person come, or this person be made this long, within the limits of one visit?
export const canAddPerson = people => people.length < MAX_PEOPLE && totalMinutes(people) + 60 <= MAX_VISIT_MINUTES
export const lengthFits = (people, index, minutes) => totalMinutes(people) - Number(people[index].duration_minutes) + minutes <= MAX_VISIT_MINUTES

// What the database is sent. A new person's name stays empty unless typed (the booking then calls them Guest 2 and so on).
export const sessionsPayload = people => people.map(person => ({
  ...(person.id ? { id: person.id } : {}), service_id: person.service_id, duration_minutes: Number(person.duration_minutes),
  recipient_name: String(person.recipient_name || '').trim() || null,
}))

// Whether anything about the people differs from the booking as it is.
export function peopleChanged(booking, people) {
  const before = peopleFromBooking(booking)
  if (before.length !== people.length) return true
  return people.some((person, index) => person.id !== before[index].id || person.service_id !== before[index].service_id
    || Number(person.duration_minutes) !== Number(before[index].duration_minutes)
    || String(person.recipient_name || '').trim() !== String(before[index].recipient_name || '').trim())
}

// The price of one person's choice from the price list, or the price they were booked at when it is unchanged.
export function personPrice(booking, person, prices) {
  const booked = (booking.booking_sessions || []).find(session => session.id === person.id)
  if (booked && booked.service_id === person.service_id && Number(booked.duration_minutes) === Number(person.duration_minutes)) return Number(booked.unit_price_gbp)
  const row = prices.find(price => price.service_id === person.service_id && Number(price.duration_minutes) === Number(person.duration_minutes))
  return row ? Number(row.price_gbp) : null
}

// What the change means for the money, from the database's answer (`plan`), in a few short lines. `who` is 'admin' (Vadim reading about
// "the client") or 'client' (the client reading about themselves).
export function moneyLines(plan, who = 'client') {
  if (!plan) return []
  const lines = []
  const total = Number(plan.total_gbp)
  const before = Number(plan.previous_total_gbp)
  const refund = Number(plan.refund_due_gbp) - Number(plan.previous_refund_due_gbp)
  const extra = Number(plan.balance_due_gbp)
  const hours = plan.free_cancellation_hours ?? 24
  if (plan.price_kept) {
    lines.push(who === 'admin'
      ? `Within ${hours} hours of the appointment, so the price stays ${money(total)}${plan.held ? ' and there is no refund' : ''}.`
      : `This is within ${hours} hours of your appointment, so the price stays ${money(total)}${plan.held ? ' and there is no refund for this change' : ''}.`)
  } else if (total !== before) {
    lines.push(`New price ${money(total)} (was ${money(before)}).`)
  } else {
    lines.push(`The price stays ${money(total)}.`)
  }
  if (refund > 0) lines.push(who === 'admin' ? `Refund to send: ${money(refund)}. It shows on the booking until you press Record refund sent.` : `You have already paid, so ${money(refund)} will be sent back to you.`)
  if (refund < 0) lines.push(who === 'admin' ? `The refund still to send goes down by ${money(-refund)}.` : `The refund on its way to you goes down by ${money(-refund)}.`)
  if (extra > 0 && extra !== Number(plan.previous_balance_due_gbp)) {
    lines.push(plan.payment_method === 'cash'
      ? `${who === 'admin' ? 'The client pays' : 'Please have'} the extra ${money(extra)} ${who === 'admin' ? 'in cash at the appointment' : 'ready in cash at your appointment'}.`
      : `${money(extra)} more to pay${who === 'admin' ? ' (the client is asked for it by bank transfer)' : ' by bank transfer. The details are in the email I send you'}.`)
  } else if (!plan.held && plan.payment_method === 'cash') {
    lines.push(`${who === 'admin' ? 'The client pays' : 'Please have'} the full ${money(total)} ${who === 'admin' ? 'in cash at the appointment' : 'ready in cash at your appointment'}.`)
  } else if (!plan.held && total !== before) {
    lines.push(`${who === 'admin' ? 'The client is now asked for' : 'The amount to pay is now'} ${money(total)}.`)
  }
  return lines
}
