import Icon from '../ui/icons.jsx'
import { bookingState, canNavigateTo, clientName, money, postcode, sessionSummary } from './calendarPresentation.js'
import { directionsLink } from './contactLinks.js'

// One appointment as a card. Tapping it opens the details. An appointment still to come also has a Directions button beside its
// status, so the way there is one tap from the list. The two are separate controls, never one inside the other.
export default function BookingCard({ booking, open, now }) {
  const state = bookingState(booking)
  const directions = canNavigateTo(booking, now) ? directionsLink(booking) : null
  return <div className={`admin-card-wrap ${directions ? 'has-directions' : ''}`}>
    <button className={`admin-card ${booking.booking_status === 'cancelled' ? 'cancelled' : ''}`} data-chip={state.chip} onClick={open}>
      <span className="admin-card-heading"><strong>{clientName(booking)}</strong><span className="admin-card-price">{money(booking.total_gbp)}</span></span>
      <span className="admin-card-treatment">{sessionSummary(booking)}</span>
      <span className="admin-card-postcode">{postcode(booking.postcode_snapshot)}</span>
      <span className={`chip chip--${state.chip} admin-status ${state.tone}`}>{state.text}</span>
    </button>
    {directions && <a className="admin-card-directions" href={directions.href} target="_blank" rel="noopener noreferrer" aria-label={`Directions to ${clientName(booking)}`}><Icon name="pin" size={15} />Directions</a>}
  </div>
}
