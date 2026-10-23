import { whatsappNumber } from './contactLinks.js'

// The Telegram link the Admin sends a client who did not press "Get updates on Telegram" themselves: the words that go with it, and the WhatsApp
// link that opens the client's own chat with those words ready to send. The link itself is made by the database (admin_create_client_telegram_link).
export function inviteMessage(firstName, link) {
  const name = String(firstName || '').trim()
  return `${name ? `Hi ${name}!` : 'Hi!'} If you would like your appointment updates on Telegram as well as by email, tap this link and press Start:\n${link}\n\nIt is optional and free (you need the Telegram app). The link works once, for the next 24 hours.\n\nWarm wishes,\nVad`
}

// Nothing when the client has no phone number that WhatsApp can use.
export function inviteWhatsappLink(phone, text) {
  const number = whatsappNumber(phone)
  return number ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : null
}

// While the Admin waits for the client to press Start, the profile looks every few seconds, for a few minutes.
export const INVITE_POLL_MS = 5000
export const INVITE_POLL_FOR_MS = 5 * 60 * 1000
