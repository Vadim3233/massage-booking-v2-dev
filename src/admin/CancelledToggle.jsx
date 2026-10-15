import { hiddenCancelled } from './cancelledBookings.js'

// The Day view and a day's own page follow the "Show cancelled" choice made in the Agenda, but have no switch of their own. So when a day has
// cancelled bookings, this says how many are out of sight and puts the choice one tap away, and when they are on show, one tap puts them away again.
// A day with none shows nothing at all.
export default function CancelledToggle({ bookings, on, change }) {
  const count = hiddenCancelled(bookings)
  if (!count) return null
  return <p className="admin-cancelled-toggle">
    <button type="button" className="btn--quiet btn--small" onClick={() => change(!on)}>{on ? 'Hide cancelled bookings' : `Show ${count} cancelled ${count === 1 ? 'booking' : 'bookings'}`}</button>
  </p>
}
