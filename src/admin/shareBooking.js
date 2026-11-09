import { dateLabel, hasStarted, money, time } from './calendarPresentation.js'
import { whatsappNumber } from './contactLinks.js'
import { bookingSentence, treatmentNoun } from '../booking/bookingWords.js'

// The booking details the Admin sends a client, as plain text WhatsApp shows well (*bold* with single asterisks, no headings or HTML). This is the only
// place the message is made: "WhatsApp client" and "Share…" both use it. It never says the Admin's notes, the client's own phone or email, internal
// ids or the booking's history. The bank details are the ones the client's own booking page shows (bankFromSettings/chooseBank), passed in.

// How every message to a client ends.
export const SIGN_OFF = 'Warm wishes,\nVadim'

const paymentOf = booking => Array.isArray(booking.booking_payments) ? booking.booking_payments[0] : booking.booking_payments

// How the money stands, in plain words.
export function paymentWords(booking) {
  const payment = paymentOf(booking)
  if (!payment) return ''
  const cash = payment.method === 'cash'
  const words = {
    paid: 'paid',
    approved: cash ? 'cash, due at the appointment' : 'approved',
    awaiting_approval: 'cash, waiting for my approval',
    awaiting_transfer: 'bank transfer – awaiting payment',
    awaiting_verification: 'bank transfer – sent, I am checking it',
    refunded: 'refunded',
  }[payment.status]
  return words ? `Payment: ${words}` : ''
}

// Whether a bank transfer is still to be made, so the payment details go with the message.
export const transferDue = booking => {
  const payment = paymentOf(booking)
  return payment?.method === 'bank_transfer' && payment.status === 'awaiting_transfer'
}

// The treatment, then the same sentence the client saw when booking: who, how long and the price ("Deep tissue: One 2-hour session for
// 1 person – £120.00"), so the number of people can never be misread.
function treatments(booking) {
  const sessions = [...(booking.booking_sessions || [])].sort((a, b) => a.position - b.position)
  if (!sessions.length) return [`${booking.treatment_duration_minutes} min`, money(booking.total_gbp)].join(' · ')
  const names = [...new Set(sessions.map(session => session.service_name_snapshot).filter(Boolean))].join(' + ') || 'Massage'
  return `${names}: ${bookingSentence(sessions.map(session => session.duration_minutes), booking.total_gbp, treatmentNoun(names))}`
}

// The Admin can reword the message (Settings › Share message), with these blanks and no others: the database refuses any other,
// so nothing but what is filled in here can ever be sent. Empty means the standard wording.
export const SHARE_BLANKS = ['date', 'time', 'address', 'treatment', 'payment', 'cancellation', 'bank details', 'calendar']
export const STANDARD_SHARE_MESSAGE = 'Hi! Thank you so much for booking with me, I am really looking forward to seeing you.\n\n*Massage booking – {date}, {time}*\n{address}\n{treatment}\n{payment}\n{cancellation}\n\nAdd it to your calendar: {calendar}\n\nIf anything changes or you have any questions, just message me here. See you soon!\n\nWarm wishes,\nVadim'
export const SHARE_MESSAGE_LIMIT = 1000
const BLANK = /\{(date|time|address|treatment|payment|bank details|cancellation|calendar)\}/g

// What is wrong with a wording, in the words the database uses when it refuses one ('' when it can be saved).
export function shareMessageProblem(text) {
  const value = text.trim()
  if (value.length > SHARE_MESSAGE_LIMIT) return `The share message can be up to ${SHARE_MESSAGE_LIMIT} characters.`
  if (/[{}]/.test(value.replace(BLANK, ''))) return 'Only the blanks listed can be used, each in curly brackets.'
  return ''
}

function bankLines(booking, bank) {
  if (!transferDue(booking) || !bank?.configured) return ''
  const payment = paymentOf(booking)
  const lines = ['Please pay by bank transfer to:', `Name: ${bank.accountName}`]
  if (bank.bankName) lines.push(`Bank: ${bank.bankName}`)
  lines.push(`Sort code: ${bank.sortCode}`, `Account number: ${bank.accountNumber}`, `Reference: ${payment.payment_reference || booking.booking_reference}`)
  if (bank.note) lines.push(bank.note)
  return lines.join('\n')
}

// What each blank says for this booking.
// Until when the client can cancel or move for free, from the database's own rule (admin_cancellation_terms): only the date is put into words
// here. Nothing is said for a booking that can no longer change, or when the terms could not be read.
const londonDay = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short' })
const londonTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
export function cancellationWords(terms) {
  if (!terms?.open || !terms.free_until) return ''
  if (terms.ended) return 'The free cancellation period has ended.'
  const until = new Date(terms.free_until)
  return `Free to cancel or move until ${londonDay.format(until).replace(',', '')}, ${londonTime.format(until)}. After that, the full price may be charged.`
}

// The "Add to your calendar" link: a page on this site where the client adds the appointment to Google Calendar, or to iPhone, Outlook and other
// calendars (server/calendarLink.js). `origin` is this site's address; without it, or without a booking id, the line is left out.
const siteOrigin = () => (typeof window !== 'undefined' ? window.location.origin : '')
export const calendarLink = (booking, origin = siteOrigin()) => (origin && booking.id ? `${origin}/calendar/${booking.id}` : '')

export function shareValues(booking, bank, terms, origin = siteOrigin()) {
  const end = booking.start_minutes + booking.treatment_duration_minutes
  return {
    date: dateLabel(booking.date).replace(',', ''),
    time: `${time(booking.start_minutes)}–${time(end)}`,
    address: booking.address_snapshot || '',
    treatment: treatments(booking),
    payment: paymentWords(booking),
    'bank details': bankLines(booking, bank),
    cancellation: cancellationWords(terms),
    calendar: calendarLink(booking, origin),
  }
}

// The wording with its blanks filled. A line whose blanks all have nothing to say (no address; no bank details when nothing is due) is left out,
// and so is a run of empty lines that leaves behind.
export function fillShareMessage(wording, values) {
  const lines = (wording?.trim() ? wording.trim() : STANDARD_SHARE_MESSAGE).split('\n').flatMap(line => {
    const blanks = line.match(BLANK)
    if (!blanks) return [line]
    // "Add it to your calendar: {calendar}" with no link to give says nothing, so it goes too.
    if (blanks.every(blank => !values[blank.slice(1, -1)])) return []
    const filled = line.replace(BLANK, (_, name) => values[name] || '')
    return filled.trim() ? [filled] : []
  })
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function shareText(booking, bank, wording = STANDARD_SHARE_MESSAGE, terms = null, origin = siteOrigin()) {
  return fillShareMessage(wording, shareValues(booking, bank, terms, origin))
}

// The payment reminder, for a client who pays later: after the session, a friendly note that the payment is still outstanding, with the bank details
// to pay it to and the reference ("If you've already sent it, please ignore this"). It is for a bank transfer not yet received, whether the client has
// said they sent it or not, once the appointment has started, and never for a cancelled or missed one. Nothing is sent by itself: it opens in
// WhatsApp, or is copied.
export const reminderDue = (booking, now = new Date()) => {
  const payment = paymentOf(booking)
  return payment?.method === 'bank_transfer' && ['awaiting_transfer', 'awaiting_verification'].includes(payment.status)
    && !['cancelled', 'no_show'].includes(booking.booking_status) && hasStarted(booking, now)
}
// How long a session was, the way a client would say it: "1 hour", "2 hours", "90 min".
export function sessionLength(minutes) {
  const value = Number(minutes)
  if (!value) return ''
  return value % 60 === 0 ? `${value / 60} ${value === 60 ? 'hour' : 'hours'}` : `${value} min`
}
// One line naming a session so the client can recognise it and check their bank: "Fri 30 Oct, 15:30 · 1 hour - £90.00".
export function owedLine(booking) {
  const length = sessionLength(booking.treatment_duration_minutes)
  return `${dateLabel(booking.date).replace(',', '')}, ${time(booking.start_minutes)}${length ? ` · ${length}` : ''} - ${money(owed(booking))}`
}
export function reminderText(booking, bank) {
  const payment = paymentOf(booking)
  const first = booking.clients?.first_name?.trim()
  const details = bank?.configured
    ? [`Sort code: ${bank.sortCode}`, `Account number: ${bank.accountNumber}`, `Reference: ${payment?.payment_reference || booking.booking_reference}`].join('\n')
    : 'Let me know if you would like my bank details again.'
  return [
    `${first ? `Hi ${first}, hope` : 'Hi, hope'} you're feeling good after your session! Just a quick reminder that payment for this session is still outstanding:`,
    '',
    owedLine(booking),
    '',
    "Here are my details in case they're handy:",
    '',
    details,
    '',
    "If you've already sent it, please ignore this. Thanks so much!",
    '',
    SIGN_OFF,
  ].join('\n')
}

// One reminder for a client who owes for more than one booking: each session's date, time and length with what it comes to, the total, and the details to
// pay it all in one transfer, with the first booking's reference. The bookings are the ones reminderDue accepts; they are listed by date.
export const owed = booking => Number(paymentOf(booking)?.amount_gbp ?? booking.total_gbp) || 0
export const owedTotal = bookings => bookings.reduce((sum, booking) => sum + owed(booking), 0)
// The client's bookings that a reminder can be sent for, earliest first, from any list of bookings (each needs its client_id).
export function dueForClient(bookings, clientId, now = new Date()) {
  if (!clientId) return []
  return bookings.filter(booking => booking.client_id === clientId && reminderDue(booking, now))
    .sort((a, b) => a.date.localeCompare(b.date) || a.start_minutes - b.start_minutes)
}
export function combinedReminderText(bookings, bank, firstName) {
  const sorted = [...bookings].sort((a, b) => a.date.localeCompare(b.date) || a.start_minutes - b.start_minutes)
  const first = String(firstName || '').trim()
  const lines = sorted.map(owedLine)
  const reference = paymentOf(sorted[0])?.payment_reference || sorted[0]?.booking_reference
  const details = bank?.configured
    ? [`Sort code: ${bank.sortCode}`, `Account number: ${bank.accountNumber}`, `Reference: ${reference}`].join('\n')
    : 'Let me know if you would like my bank details again.'
  return [
    `${first ? `Hi ${first}, hope` : 'Hi, hope'} you're feeling good after your sessions! Just a quick reminder that payment is still outstanding:`,
    '',
    ...lines,
    `Total: ${money(owedTotal(sorted))}`,
    '',
    "Here are my details in case they're handy:",
    '',
    details,
    '',
    "If you've already sent it, please ignore this. Thanks so much!",
    '',
    SIGN_OFF,
  ].join('\n')
}

// WhatsApp straight to the client's chat with the message in it, or nothing when the booking has no usable phone number.
export function whatsappShareLink(booking, text) {
  const number = whatsappNumber(booking.clients?.phone)
  return number ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : null
}

// A cancelled booking is not shared.
export const canShare = booking => booking.booking_status !== 'cancelled'
