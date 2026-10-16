import { money } from '../booking/bookingDraft.js'

// The one quiet line under a booking in Your bookings that says where its money stands: what it comes to and whether that is paid, still to
// pay or to be paid in cash, and, after a cancellation, a refund on its way or a late fee that is due. The words are the ones the booking's own
// page uses ("Payment received", "Cash on arrival"), shortened. `upcoming` is whether the booking is under Coming up: a cash booking that has
// been and gone no longer says to pay at the appointment. The tone is `ok` for money that is settled and `due` for money that still has to move
// (the line is `due` whenever any part of it is); anything else has none. A booking with nothing to say, such as a cancelled one with nothing
// owed either way, gets no line at all.
export function paymentLine(row, { upcoming = false } = {}) {
  const total = Number(row.total_gbp) > 0 ? money(row.total_gbp) : ''
  const parts = []
  let tone = ''
  const add = (text, kind = '') => {
    parts.push(text)
    if (kind === 'due' || (kind && !tone)) tone = kind
  }
  if (row.booking_status === 'cancelled') {
    if (row.payment_status === 'paid' && Number(row.refund_due_gbp) > 0) add(`Refund of ${money(row.refund_due_gbp)} on its way`, 'due')
    else if (row.payment_status === 'refunded') add('Refunded')
  } else if (total) {
    if (row.payment_status === 'paid') add(`${total} · Paid`, 'ok')
    else if (row.payment_status === 'approved' && upcoming) add(`${total} · Pay in cash at your appointment`, 'due')
    else if (row.payment_status === 'approved' || row.payment_status === 'awaiting_approval') add(`${total} · Cash`)
    else if (row.payment_status === 'awaiting_transfer') add(`${total} to pay by bank transfer`, 'due')
    else if (row.payment_status === 'awaiting_verification') add(total)
    else if (row.payment_status === 'refunded') add('Refunded')
  }
  if (row.late_fee_status === 'due' && Number(row.late_fee_due_gbp) > 0) add(`Late fee of ${money(row.late_fee_due_gbp)} due`, 'due')
  return parts.length ? { text: parts.join(' · '), tone } : null
}
