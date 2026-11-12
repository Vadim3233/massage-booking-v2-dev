import { whatsappNumber } from './contactLinks.js'

// Asking a client for a Google review (More › Google reviews, and the card on a booking once the session is over and paid).
// The standard wording is the same as public.standard_review_message() in the database, which the automatic message uses: change both together.
export const STANDARD_REVIEW_MESSAGE = 'Hi {name}! I hope you enjoyed our last session and you\'re still feeling the benefit of it. If you have a minute, a short Google review would mean a lot to me. It really helps other people find me:\n{link}\n\nWarm wishes,\nVadim'
export const REVIEW_BLANKS = ['name', 'link']
export const REVIEW_MESSAGE_LIMIT = 1000
const BLANK = /\{(name|link)\}/g

// What is wrong with a wording, in the words the database uses when it refuses one ('' when it can be saved).
export function reviewMessageProblem(text) {
  const value = String(text || '').trim()
  if (!value) return ''
  if (value.length > REVIEW_MESSAGE_LIMIT) return `The review message can be up to ${REVIEW_MESSAGE_LIMIT} characters.`
  if (/[{}]/.test(value.replace(BLANK, ''))) return 'Only the blanks listed can be used, each in curly brackets.'
  if (!value.includes('{link}')) return 'The message needs the {link} blank, so clients can find your review page.'
  return ''
}

// What is wrong with a review link ('' when it is fine, or empty).
export function reviewLinkProblem(link) {
  const value = String(link || '').trim()
  if (!value) return ''
  if (!/^https:\/\/[^\s<>"]+$/.test(value) || value.length > 300) return 'The review link must start with https:// and have no spaces.'
  return ''
}

// The message for one client: {name} is their first name, left out with the space before it when none is saved ("Hi!").
export function reviewText(wording, firstName, link) {
  const name = String(firstName || '').trim()
  const text = String(wording || '').trim() || STANDARD_REVIEW_MESSAGE
  const named = name ? text.replaceAll('{name}', name) : text.replace(/ ?\{name\}/g, '')
  return named.replaceAll('{link}', String(link || '').trim()).trim()
}

// A review is asked for once the session is over (its end has passed, London time) and it is paid, and only for a booking that went ahead.
export function canAskForReview(booking, now = new Date()) {
  if (!['confirmed', 'completed'].includes(booking?.booking_status)) return false
  const payment = Array.isArray(booking.booking_payments) ? booking.booking_payments[0] : booking.booking_payments
  if (payment?.status !== 'paid') return false
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map(part => [part.type, part.value]))
  const today = `${parts.year}-${parts.month}-${parts.day}`
  if (booking.date < today) return true
  if (booking.date > today) return false
  return Number(parts.hour) * 60 + Number(parts.minute) >= booking.start_minutes + booking.treatment_duration_minutes
}

export const reviewWhatsappLink = (phone, text) => {
  const number = whatsappNumber(phone)
  return number ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : null
}

// "Review asked · 12 Nov by WhatsApp"
const HOW = { whatsapp: 'by WhatsApp', copy: 'message copied', marked: 'marked by you', automatic: 'by email' }
export function askedWords(asked) {
  if (!asked?.asked_at) return ''
  const day = new Date(asked.asked_at).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' })
  return `Review asked · ${day}${HOW[asked.channel] ? ` · ${HOW[asked.channel]}` : ''}`
}
