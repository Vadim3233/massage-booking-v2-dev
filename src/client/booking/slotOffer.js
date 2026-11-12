// A special-price offer's link (Vadim, 12 Nov 2026): /offer/K7Q2MX opens the booking with one time, one length and one all-in price fixed.
// The database holds the price and decides who gets it (20261207100000_special_price_offers.sql); this only shapes the booking pages around it.

// The code in the link, or null.
export const offerCodeFromPath = (path) => /^\/offer\/([A-Za-z0-9]{6,12})\/?$/.exec(path || '')?.[1]?.toUpperCase() ?? null

// What the draft keeps of an offer the link says is open (or being booked by someone right now).
export const offerFromRow = (code, row) => ({
  code, date: row.date, start: row.start_minutes, minutes: row.duration_minutes, price: Number(row.price_gbp),
  normal: row.normal_price_gbp == null ? null : Number(row.normal_price_gbp),
  addTravelFee: row.add_travel_fee === true,
})

// The booking pages read the catalogue; for an offer it is narrowed to what the offer allows: the treatments that come in its length, at its
// price, with no extras, and no travel fee or congestion charge shown on the areas unless Vadim ticked "Add travel fee".
export function catalogueForOffer(catalogue, offer) {
  if (!catalogue || !offer) return catalogue
  const prices = catalogue.prices.filter(price => price.duration_minutes === offer.minutes).map(price => ({ ...price, price_gbp: offer.price }))
  const services = catalogue.services.filter(service => prices.some(price => price.service_id === service.id))
  return {
    ...catalogue,
    areas: catalogue.areas.map(area => ({ ...area, ...(offer.addTravelFee ? {} : { travel_surcharge_gbp: 0, congestion_fee_gbp: 0 }), minimum_booking_minutes: null })),
    services, prices, enhancements: [],
  }
}

// The words for what the link says when it cannot be booked.
export const OFFER_GONE = {
  taken: 'Sorry, this special time has just been booked by someone else.',
  closed: 'Sorry, this special offer has now closed.',
  missing: "Sorry, this special offer link doesn't work. Please check it with Vadim.",
}
