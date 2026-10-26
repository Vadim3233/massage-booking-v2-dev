import { useState } from 'react'
import Icon from '../ui/icons.jsx'
import { ActionDialog } from './BookingActions.jsx'
import { DONE, lifecycleActions, lifecycleApi } from './bookingLifecycleApi.js'
import { toast } from '../ui/toast.js'
import { bookingEnd, bookingState, canNavigateTo, clientName, extrasList, hasStarted, money, time, treatmentName } from './calendarPresentation.js'
import { paymentActions, paymentReviewApi } from './paymentReviewApi.js'
import { shortWhere } from '../lib/address.js'
import { cancelledNote, moneyToSort } from './cancelledBookings.js'
import { directionsLink } from './contactLinks.js'
import { peopleShort } from '../booking/bookingWords.js'

// One appointment as a card, as wide as the screen allows. Its time is at the top of the card, so a list of cards needs no column of times
// beside it: when the treatment starts and ends, then how long it is. Tapping the card opens the details. An appointment still to come also
// has a Directions button beside its status, so the way there is one tap from the list. The two are separate controls, never one inside
// the other. `tag` is the small "Now" or "Next" the Agenda puts on the appointment that is under way or coming up. A cancelled booking that
// still has a refund to send or a late fee to collect says so in its status, in the colour of things that need the Admin, though the card
// itself stays grey: it is cancelled, and the money is what is left to do. A cancelled card also says who cancelled it and when, after its
// status (on the next line when the status is long), so a late cancellation shows without opening the booking.
// `changed` is how the list is read again after a refund is recorded from the card; without it, the card offers no Record refund.
// Extras the client added (a heated table cover, hot stones) get a line of their own under the treatment, so they are seen without opening the booking;
// a cancelled card leaves them out. A booking with none is no taller than before.
// Cash agreed for the appointment is not income until it is received: once the appointment has started, the card offers Cash received
// (the same action as Mark payment received on the booking), after a question, so it is one tap from the list. A confirmed booking whose
// bank transfer is still to come ("Confirm, pay later") offers Mark paid the same way once the appointment is over (before that, the booking has it).
export default function BookingCard({ booking, open, now, tag, changed }) {
  const [refunding, setRefunding] = useState(false)
  const refundable = Boolean(changed) && lifecycleActions(booking).includes('refund')
  const [receiving, setReceiving] = useState(false)
  const cashDue = Boolean(changed) && paymentActions(booking).includes('receive') && hasStarted(booking, now)
  const cashAmount = money(booking.booking_payments?.amount_gbp ?? booking.total_gbp)
  async function receiveCash() {
    const action = cashDue ? 'receive' : 'receiveBank'
    const question = cashDue ? `Mark ${cashAmount} cash received from ${clientName(booking)}?` : `Has ${cashAmount} from ${clientName(booking)} reached your bank? Look for the reference ${booking.booking_reference}.`
    if (receiving || !window.confirm(question)) return
    setReceiving(true)
    try { await paymentReviewApi.act(action, booking, crypto.randomUUID()); toast(`${cashDue ? 'Cash received' : 'Paid'} · ${clientName(booking)}`) } catch (failure) { toast(failure.message) }
    setReceiving(false)
    await changed()
  }
  async function refunded(text, isError = false) {
    setRefunding(false)
    if (!isError) toast(`${DONE.refund} · ${clientName(booking)}`)
    else toast(text)
    await changed()
  }
  const state = bookingState(booking)
  const owed = moneyToSort(booking)
  const cancelled = cancelledNote(booking)
  const directions = canNavigateTo(booking, now) ? directionsLink(booking) : null
  // Before the appointment ends the foot of the card holds Directions, so Mark paid is then on the booking itself.
  const transferDue = Boolean(changed) && !directions && paymentActions(booking).includes('receiveBank')
  const where = shortWhere(booking.address_snapshot)
  const extras = booking.booking_status === 'cancelled' ? [] : extrasList(booking)
  return <div className={`admin-card-wrap ${directions ? 'has-directions' : ''} ${refundable || cashDue || transferDue ? 'has-card-action' : ''}`}>
    <button className={`admin-card ${booking.booking_status === 'cancelled' ? 'cancelled' : ''}`} data-chip={state.chip} data-variant={state.variant} onClick={open}>
      <span className="admin-card-when">
        <span className="admin-card-times">{time(booking.start_minutes)}<span aria-hidden="true"> – </span><span className="admin-sr-only"> to </span>{time(bookingEnd(booking))}</span>
        {tag && <em className="admin-next-tag">{tag}</em>}
        {/* How many people and how long each ("1 person · 120 min", "3 people · 3 × 60 min"), so a group can never be mistaken for one long session. */}
        <span className="admin-card-length">{booking.booking_sessions?.length ? peopleShort([...booking.booking_sessions].sort((a, b) => a.position - b.position).map(session => session.duration_minutes)) : `${booking.treatment_duration_minutes} min`}</span>
      </span>
      <span className="admin-card-heading"><strong>{clientName(booking)}</strong><span className="admin-card-price">{money(booking.total_gbp)}</span></span>
      <span className="admin-card-meta">
        <span className="admin-card-treatment">{treatmentName(booking)}</span>
        {where && <><span aria-hidden="true">·</span><span className="admin-card-postcode">{where}</span></>}
      </span>
      {extras.length > 0 && <span className="admin-card-extras"><Icon name="plus" size={14} /><span><span className="admin-sr-only">Extras: </span>{extras.join(' · ')}</span></span>}
      <span className="admin-card-foot">
        {state.pills && !owed
          ? <span className="admin-status-pair">{state.pills.map(pill => <span key={pill.text} className={`chip chip--${pill.chip} admin-status`}>{pill.text}</span>)}</span>
          : <span className={`chip chip--${owed ? 'needs' : state.chip} admin-status ${state.tone}`}>{owed ? `${state.text} · ${owed}` : state.text}</span>}
        {cancelled && <span className="admin-card-cancelled-when">{cancelled}</span>}
      </span>
    </button>
    {refundable && <button type="button" className="admin-card-refund" aria-label={`Record refund sent to ${clientName(booking)}`} onClick={() => setRefunding(true)}><Icon name="check" size={15} />Record refund</button>}
    {cashDue && <button type="button" className="admin-card-refund admin-card-cash" disabled={receiving} aria-label={`Mark ${cashAmount} cash received from ${clientName(booking)}`} onClick={receiveCash}><Icon name="check" size={15} />Cash received</button>}
    {transferDue && <button type="button" className="admin-card-refund admin-card-cash" disabled={receiving} aria-label={`Mark ${cashAmount} from ${clientName(booking)} paid`} onClick={receiveCash}><Icon name="check" size={15} />Mark paid</button>}
    {refunding && <ActionDialog kind="refund" booking={booking} api={lifecycleApi} close={() => setRefunding(false)} done={refunded} />}
    {directions && <a className="admin-card-directions" href={directions.href} target="_blank" rel="noopener noreferrer" aria-label={`Directions to ${clientName(booking)}`}><Icon name="pin" size={15} />Directions</a>}
  </div>
}
