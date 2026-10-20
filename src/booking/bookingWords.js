// How a booking is put into words, the same everywhere it is shown (Vadim's change request 2, 20 Oct 2026): how many people, how long each,
// and the price, so "2 hours for 1 person" can never be read as "2 people". One person's session is one row of booking_sessions.

// The most a visit can hold. The database refuses more (compute_client_booking_quote: 1 to 4 sessions, at most 240 minutes); the test
// bookingLimits.integration.test.js checks that these numbers still agree with it.
export const MAX_PEOPLE = 4
export const MAX_VISIT_MINUTES = 240

const WORDS = ['', 'One', 'Two', 'Three', 'Four']
const count = n => WORDS[n] || String(n)
const money = amount => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(amount)
// "60-minute", "90-minute", "2-hour".
export const lengthWord = minutes => minutes >= 120 && minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`
// "60 min", "2 hours".
export const shortLength = minutes => minutes >= 120 && minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} min`
// "1 hour", "2 hours", "2 hours 30 minutes".
export function hoursWords(minutes) {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return [hours ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : '', rest ? `${rest} minutes` : ''].filter(Boolean).join(' ')
}
// Massage for the massage treatments, session for anything else ("One 2-hour session for 1 person").
export const treatmentNoun = serviceName => /massage/i.test(serviceName || '') ? 'massage' : 'session'

// "One 2-hour massage for 1 person", "Three 60-minute massages for 3 people, one after the other – 3 hours in total",
// "Two massages for 2 people, one after the other (60 min + 90 min) – 2 hours 30 minutes in total".
export function peopleSentence(durations, noun = 'massage') {
  const people = durations.length
  if (!people) return ''
  const total = durations.reduce((sum, minutes) => sum + minutes, 0)
  if (people === 1) return `One ${lengthWord(durations[0])} ${noun} for 1 person`
  const plural = `${noun}s`
  return durations.every(minutes => minutes === durations[0])
    ? `${count(people)} ${lengthWord(durations[0])} ${plural} for ${people} people, one after the other – ${hoursWords(total)} in total`
    : `${count(people)} ${plural} for ${people} people, one after the other (${durations.map(minutes => `${minutes} min`).join(' + ')}) – ${hoursWords(total)} in total`
}
// The sentence with the price: "One 2-hour massage for 1 person – £170.00".
export const bookingSentence = (durations, totalGbp, noun) => `${peopleSentence(durations, noun)} – ${money(Number(totalGbp))}`

// Short, for the Admin's card: "1 person · 120 min", "3 people · 3 × 60 min", "2 people · 60 + 90 min".
export function peopleShort(durations) {
  const people = durations.length
  if (!people) return ''
  const who = `${people} ${people === 1 ? 'person' : 'people'}`
  if (people === 1) return `${who} · ${durations[0]} min`
  return durations.every(minutes => minutes === durations[0]) ? `${who} · ${people} × ${durations[0]} min` : `${who} · ${durations.join(' + ')} min`
}

// The price of an option before anything else is chosen: the sessions at the treatment's prices, plus the area's travel and congestion fees
// (the same parts the database's quote adds; extras come later). Nothing when a length has no price.
export function optionTotal(prices, area, durations) {
  const each = durations.map(minutes => prices.find(price => price.duration_minutes === minutes))
  if (!durations.length || each.some(price => !price)) return null
  return each.reduce((sum, price) => sum + Number(price.price_gbp), 0) + Number(area?.travel_surcharge_gbp || 0) + Number(area?.congestion_fee_gbp || 0)
}
// How many people can come at all: as many as fit at the shortest length (never more than the visit allows).
export function peopleChoices(prices) {
  const shortest = Math.min(...prices.map(price => price.duration_minutes))
  if (!Number.isFinite(shortest)) return []
  return Array.from({ length: Math.min(MAX_PEOPLE, Math.floor(MAX_VISIT_MINUTES / shortest)) }, (_, index) => index + 1)
}
