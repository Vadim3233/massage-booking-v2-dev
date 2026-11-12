import { createAdminGate } from './adminGate.js'
import { SIGN_OFF } from './shareBooking.js'
import { dateLabel, money, shiftDate, time } from './calendarPresentation.js'

// Special-price offers for a free time (Vadim, 12 Nov 2026): the words, the link, the choices in the form and how an offer sits in the day.
// The database decides everything that matters (20261207100000_special_price_offers.sql); this only shows and asks.

const siteOrigin = () => (typeof window !== 'undefined' ? window.location.origin : '')
export const offerLink = (offer, origin = siteOrigin()) => `${origin}/offer/${offer.code}`

// The moment a London date and time happens, as a Date (the clocks change twice a year, so London is not always UTC).
export function londonInstant(date, minutes) {
  const [year, month, day] = date.split('-').map(Number)
  const wall = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60)
  const offsetAt = (instant) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(new Date(instant)).map(part => [part.type, Number(part.value)]))
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - instant
  }
  let instant = wall - offsetAt(wall)
  instant = wall - offsetAt(instant)
  return new Date(instant)
}

// "today, Thursday 12 November", "tomorrow, Friday 13 November" or "on Saturday 14 November".
export function offerDay(date, todayDate) {
  const long = dateLabel(date, { weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '')
  if (date === todayDate) return `today, ${long}`
  if (date === shiftDate(todayDate, 1)) return `tomorrow, ${long}`
  return `on ${long}`
}

const pounds = value => money(value).replace(/\.00$/, '')
export const offerPrice = offer => pounds(offer.price_gbp)

// The message Vadim copies to WhatsApp. "instead of" only when it really is cheaper.
export function offerMessage(offer, todayDate, origin = siteOrigin()) {
  const end = offer.start_minutes + offer.duration_minutes
  const normal = Number(offer.normal_price_gbp)
  const cheaper = normal > Number(offer.price_gbp) ? ` instead of ${pounds(normal)}` : ''
  return [
    `Hi! I've just had a time free up ${offerDay(offer.date, todayDate)}, ${time(offer.start_minutes)} to ${time(end)}.`,
    '',
    `A ${offer.duration_minutes}-minute massage at your home for ${pounds(offer.price_gbp)}${cheaper}. First to book gets it:`,
    offerLink(offer, origin),
    '',
    SIGN_OFF,
  ].join('\n')
}

export const whatsappOfferLink = text => `https://wa.me/?text=${encodeURIComponent(text)}`

export const londonClock = at => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)

// When the offer stops being offered: so long before the start. Only times still to come are offered; "when it starts" is always last.
const BEFORE = [[60, '1 hour before'], [30, '30 minutes before'], [120, '2 hours before'], [180, '3 hours before'], [0, 'When it starts']]
export function closingChoices(date, start, now = Date.now()) {
  return BEFORE.map(([minutes, label]) => ({ minutes, label, at: new Date(londonInstant(date, start).getTime() - minutes * 60000) }))
    .filter(choice => choice.at.getTime() > now)
    .map(choice => ({ ...choice, label: `${choice.label} (${londonClock(choice.at)})` }))
}

// The lengths that fit a free stretch, and the starts (on the half hour) where the chosen one fits.
export const lengthsThatFit = (free, durations) => durations.filter(minutes => minutes <= free.end - free.start)
export function startsThatFit(free, minutes, earliest = 0) {
  const starts = []
  for (let start = Math.ceil(Math.max(free.start, earliest) / 30) * 30; start + minutes <= free.end; start += 30) starts.push(start)
  return starts
}

// The room an offer can use (Vadim, 12 Nov 2026): the free stretch plus the travel time right next to it, because he decides
// how much travel he needs. A 30-minute gap between two hours of travel can still take a 60-minute offer.
export function roomAround(rows, row) {
  let start = row.start, end = row.end
  for (let moved = true; moved;) {
    moved = false
    for (const next of rows) {
      if (next.kind !== 'buffer') continue
      if (next.end === start && next.start < start) { start = next.start; moved = true }
      if (next.start === end && next.end > end) { end = next.end; moved = true }
    }
  }
  return { start, end, free: { start: row.start, end: row.end } }
}

// The start Vadim most likely wants: the one that uses the most of the free stretch (the earliest when two do the same).
export function bestStart(room, minutes, earliest = 0) {
  const free = room.free || room
  const used = start => Math.max(0, Math.min(start + minutes, free.end) - Math.max(start, free.start))
  return startsThatFit(room, minutes, earliest).reduce((best, start) => (best == null || used(start) > used(best) ? start : best), null)
}

// How many minutes of travel time an offer at this start takes.
export const travelUsed = (room, start, minutes) => {
  const free = room.free || room
  return Math.max(0, free.start - start) + Math.max(0, start + minutes - free.end)
}

// The day's rows with the open offers in them: an offer takes its time out of a free stretch (or travel time) and shows in its place.
export function withOffers(rows, offers = []) {
  if (!offers.length) return rows
  const out = []
  for (const row of rows) {
    if (row.kind !== 'free' && row.kind !== 'buffer') { out.push(row); continue }
    let pieces = [[row.start, row.end]]
    for (const offer of offers) {
      const from = offer.start_minutes, to = offer.start_minutes + offer.duration_minutes
      pieces = pieces.flatMap(([start, end]) => (to <= start || from >= end ? [[start, end]] : [[start, from], [to, end]].filter(([a, b]) => b > a)))
    }
    for (const [start, end] of pieces) out.push({ ...row, id: `${row.kind}-${start}`, start, end })
  }
  for (const offer of offers) out.push({ kind: 'offer', id: offer.id, start: offer.start_minutes, end: offer.start_minutes + offer.duration_minutes, offer })
  return out.sort((a, b) => a.start - b.start || (a.kind === 'offer' ? -1 : b.kind === 'offer' ? 1 : 0))
}

// Whether a free stretch can still be offered: today or later, and not already over.
export const canOffer = (date, free, todayDate, nowMinutes) => date > todayDate || (date === todayDate && free.end - 30 > nowMinutes)

export const offerSummary = offer => `${time(offer.start_minutes)} – ${time(offer.start_minutes + offer.duration_minutes)} · ${offer.duration_minutes} min · ${pounds(offer.price_gbp)}`

async function unwrap(request) {
  const { data, error } = await request
  if (error) throw new Error(error.message || 'Something went wrong. Please try again.')
  return data
}

export function createOfferApi(client) {
  const authorized = createAdminGate(client, { signedOut: 'Admin sign-in required.', denied: 'This account does not have Admin access.' })
  return {
    // The open offers of the days shown (end not included).
    async open(start, end) {
      await authorized()
      return unwrap(client.from('slot_offers').select('*').gte('date', start).lt('date', end).eq('status', 'open').gt('closes_at', new Date().toISOString()).order('start_minutes'))
    },
    // The lengths treatments come in, each with its usual (cheapest) price, for the form.
    async lengths() {
      const rows = await unwrap(client.from('service_duration_prices').select('duration_minutes,price_gbp,services!inner(active)').eq('active', true).eq('services.active', true))
      const cheapest = new Map()
      for (const row of rows) cheapest.set(row.duration_minutes, Math.min(cheapest.get(row.duration_minutes) ?? Infinity, Number(row.price_gbp)))
      return [...cheapest].map(([minutes, price]) => ({ minutes, price })).sort((a, b) => a.minutes - b.minutes)
    },
    create: ({ date, start, minutes, price, closesAt }) => unwrap(client.rpc('admin_create_slot_offer', { p_date: date, p_start_minutes: start, p_duration_minutes: minutes, p_price_gbp: price, p_closes_at: closesAt.toISOString() })),
    update: (id, { price, closesAt }) => unwrap(client.rpc('admin_update_slot_offer', { p_offer_id: id, p_price_gbp: price, p_closes_at: closesAt.toISOString() })),
    stop: id => unwrap(client.rpc('admin_stop_slot_offer', { p_offer_id: id })),
  }
}
