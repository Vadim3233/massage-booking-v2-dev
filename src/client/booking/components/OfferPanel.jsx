import Icon from '../../../ui/icons.jsx'
import { money, timeLabel } from '../bookingDraft.js'
import { dayParts } from '../dateStrip.js'
import { OFFER_GONE } from '../slotOffer.js'

const whole = amount => money(amount).replace(/\.00$/, '')

// What the offer is: the day and time, the length and the price. Shown at the top of the booking while it is an offer.
export function OfferCard({ offer, busy = false, heading = true }) {
  const cheaper = offer.normal != null && offer.normal > offer.price
  return <section className="offer-card" aria-labelledby={heading ? 'offer-title' : undefined} aria-label={heading ? undefined : 'Your special offer'}>
    <p className="offer-tag"><Icon name="sparkle" size={14} />{cheaper || offer.normal == null ? 'Special offer' : 'One time left'}</p>
    {heading ? <h1 id="offer-title" tabIndex={-1}>{dayParts(offer.date).long}<br /><em>{timeLabel(offer.start)}–{timeLabel(offer.start + offer.minutes)}</em></h1>
      : <p className="offer-when">{dayParts(offer.date).long}, {timeLabel(offer.start)}–{timeLabel(offer.start + offer.minutes)}</p>}
    <p className="offer-price"><strong className="figure">{whole(offer.price)}</strong>{cheaper && <s>{whole(offer.normal)}</s>}<span>{offer.minutes}-minute massage for one, at your home. {offer.addTravelFee ? 'Plus the travel fee for your area, if it has one.' : "That's all you pay: no travel fee or extras."}</span></p>
    {busy && <p className="offer-busy" role="status">Someone is booking this time right now. If they don't finish in the next few minutes, it can be yours.</p>}
    {heading && <p className="offer-steps">Choose your area and treatment, then add your details. First to book gets it.</p>}
  </section>
}

// Step "Date & Time" for an offer: the time is fixed, so this only holds it.
export function OfferTimeStep({ offer, hold, busy }) {
  return <>
    <h1 tabIndex={-1}>Your <em>time</em></h1>
    <OfferCard offer={offer} heading={false} />
    <p className="lede">Tap below and the time is held for you while you add your details.</p>
    <button className="btn--primary" disabled={busy} onClick={hold}>Hold this time for me</button>
  </>
}

// The link cannot be booked any more: say so kindly, and offer the usual booking page.
export function OfferGone({ state }) {
  return <section className="offer-card offer-card--gone" aria-labelledby="offer-gone-title">
    <h1 id="offer-gone-title" tabIndex={-1}>{OFFER_GONE[state] || OFFER_GONE.closed}</h1>
    <p className="lede">You can still book any of my other free times.</p>
    <a className="btn btn--primary" href="/">See my free times</a>
  </section>
}
