import Icon from '../ui/icons.jsx'
import { bookingEnd, bookingState, canNavigateTo, clientName, money, time, treatmentName } from './calendarPresentation.js'
import { shortWhere } from '../lib/address.js'
import { cancelledNote, moneyToSort } from './cancelledBookings.js'
import { directionsLink } from './contactLinks.js'

// One appointment as a card, as wide as the screen allows. Its time is at the top of the card, so a list of cards needs no column of times
// beside it: when the treatment starts and ends, then how long it is. Tapping the card opens the details. An appointment still to come also
// has a Directions button beside its status, so the way there is one tap from the list. The two are separate controls, never one inside
// the other. `tag` is the small "Now" or "Next" the Agenda puts on the appointment that is under way or coming up. A cancelled booking that
// still has a refund to send or a late fee to collect says so in its status, in the colour of things that need the Admin, though the card
// itself stays grey: it is cancelled, and the money is what is left to do. A cancelled card also says who cancelled it and when, after its
// status (on the next line when the status is long), so a late cancellation shows without opening the booking.
export default function BookingCard({ booking, open, now, tag }) {
  const state = bookingState(booking)
  const owed = moneyToSort(booking)
  const cancelled = cancelledNote(booking)
  const directions = canNavigateTo(booking, now) ? directionsLink(booking) : null
  const where = shortWhere(booking.address_snapshot)
  return <div className={`admin-card-wrap ${directions ? 'has-directions' : ''}`}>
    <button className={`admin-card ${booking.booking_status === 'cancelled' ? 'cancelled' : ''}`} data-chip={state.chip} onClick={open}>
      <span className="admin-card-when">
        <span className="admin-card-times">{time(booking.start_minutes)}<span aria-hidden="true"> – </span><span className="admin-sr-only"> to </span>{time(bookingEnd(booking))}</span>
        {tag && <em className="admin-next-tag">{tag}</em>}
        <span className="admin-card-length">{booking.treatment_duration_minutes} min</span>
      </span>
      <span className="admin-card-heading"><strong>{clientName(booking)}</strong><span className="admin-card-price">{money(booking.total_gbp)}</span></span>
      <span className="admin-card-meta">
        <span className="admin-card-treatment">{treatmentName(booking)}</span>
        {where && <><span aria-hidden="true">·</span><span className="admin-card-postcode">{where}</span></>}
      </span>
      <span className="admin-card-foot">
        <span className={`chip chip--${owed ? 'needs' : state.chip} admin-status ${state.tone}`}>{owed ? `${state.text} · ${owed}` : state.text}</span>
        {cancelled && <span className="admin-card-cancelled-when">{cancelled}</span>}
      </span>
    </button>
    {directions && <a className="admin-card-directions" href={directions.href} target="_blank" rel="noopener noreferrer" aria-label={`Directions to ${clientName(booking)}`}><Icon name="pin" size={15} />Directions</a>}
  </div>
}
