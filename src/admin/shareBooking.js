import { dateLabel, money, time } from './calendarPresentation.js'
import { whatsappNumber } from './contactLinks.js'

// The booking details the Admin sends a client, as plain text WhatsApp shows well (*bold* with single asterisks, no headings or HTML). This is the only
// place the message is made: "WhatsApp client" and "Share…" both use it. It never says the Admin's notes, the client's own phone or email, internal
// ids or the booking's history. The bank details are the ones the client's own booking page shows (bankFromSettings/chooseBank), passed in.

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

function treatments(booking) {
  const sessions = [...(booking.booking_sessions || [])].sort((a, b) => a.position - b.position)
  const names = sessions.length === 1
    ? sessions[0].service_name_snapshot
    : sessions.map(session => `${session.service_name_snapshot} ${session.duration_minutes} min`).join(' + ')
  return [names || 'Massage', `${booking.treatment_duration_minutes} min`, money(booking.total_gbp)].join(' · ')
}

// The Admin can reword the message (Settings › Share message), with these blanks and no others: the database refuses any other,
// so nothing but what is filled in here can ever be sent. Empty means the standard wording.
export const SHARE_BLANKS = ['date', 'time', 'address', 'treatment', 'payment', 'bank details']
export const STANDARD_SHARE_MESSAGE = '*Massage booking – {date}, {time}*\n{address}\n{treatment}\n{payment}\n\n{bank details}'
export const SHARE_MESSAGE_LIMIT = 1000
const BLANK = /\{(date|time|address|treatment|payment|bank details)\}/g

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
export function shareValues(booking, bank) {
  const end = booking.start_minutes + booking.treatment_duration_minutes
  return {
    date: dateLabel(booking.date).replace(',', ''),
    time: `${time(booking.start_minutes)}–${time(end)}`,
    address: booking.address_snapshot || '',
    treatment: treatments(booking),
    payment: paymentWords(booking),
    'bank details': bankLines(booking, bank),
  }
}

// The wording with its blanks filled. A line whose blanks have nothing to say (no address; no bank details when nothing is due) is left out,
// and so is a run of empty lines that leaves behind.
export function fillShareMessage(wording, values) {
  const lines = (wording?.trim() ? wording.trim() : STANDARD_SHARE_MESSAGE).split('\n').flatMap(line => {
    if (!line.match(BLANK)) return [line]
    const filled = line.replace(BLANK, (_, name) => values[name] || '')
    return filled.trim() ? [filled] : []
  })
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function shareText(booking, bank, wording = STANDARD_SHARE_MESSAGE) {
  return fillShareMessage(wording, shareValues(booking, bank))
}

// WhatsApp straight to the client's chat with the message in it, or nothing when the booking has no usable phone number.
export function whatsappShareLink(booking, text) {
  const number = whatsappNumber(booking.clients?.phone)
  return number ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : null
}

// A cancelled booking is not shared.
export const canShare = booking => booking.booking_status !== 'cancelled'
