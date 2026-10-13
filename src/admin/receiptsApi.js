import { supabase } from '../lib/supabase.js'
import { whatsappNumber } from './contactLinks.js'

// Messages written for the Admin on the server. Anything else becomes a generic line.
export const SAFE_MESSAGES = new Set([
  'Enter your business name', 'Add a phone number or an email address for the receipt', 'That email address does not look right', 'That is too long',
  'Invalid receipt details', 'Invalid receipt changes', 'Enter who the receipt is for', 'Every line of the receipt needs its words',
  'Save your receipt details first', 'A receipt can be made once the payment is marked as received', 'This payment was refunded, so there is no receipt',
  'A cancelled booking has no receipt', 'A missed appointment has no receipt', 'The amount paid does not match the booking, so a receipt cannot be made',
  'The prices on this booking do not add up to its total, so a receipt cannot be made', 'There is no email address on this booking',
  'This booking has no receipt yet', 'Booking unavailable', 'That contains characters that cannot be used',
  'This booking was cancelled, so its receipt can no longer be sent or changed', 'This payment was refunded, so its receipt can no longer be sent or changed',
  'This appointment was marked as missed, so its receipt can no longer be sent or changed',
  'The payment is no longer marked as received, so its receipt can no longer be sent or changed',
])
const GENERIC = 'Could not complete that. Please check your connection and try again.'
export const NEEDS_DETAILS = 'Save your receipt details first'

export const EMPTY_DETAILS = { name: '', phone: '', email: '', address: '', closing: '' }

// The same checks the database makes, so a slip is caught with a plain sentence before anything is sent.
export function validateReceiptDetails(details) {
  if (!details.name?.trim()) return 'Enter your business name.'
  const email = (details.email || '').trim()
  if (!details.phone?.trim() && !email) return 'Add a phone number or an email address.'
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'That email address does not look right.'
  return ''
}

// What an edit may change: who it is for, a note, the words of each line, and her details. Amounts never go from here.
export function validateReceiptEdit({ billed_to: billedTo, lines, business }) {
  if (!billedTo?.trim()) return 'Enter who the receipt is for.'
  if (lines.some(line => !line.trim())) return 'Every line of the receipt needs its words.'
  return validateReceiptDetails(business)
}

// A WhatsApp chat with the client with the receipt already typed in, ready to send. Nothing without a phone number.
export function whatsappReceiptLink(phone, text) {
  const number = whatsappNumber(phone)
  return number ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : null
}

export function createReceiptsApi(client) {
  async function call(name, args) {
    const { data, error } = await client.rpc(name, args)
    if (error) throw new Error(SAFE_MESSAGES.has(error.message) ? error.message : GENERIC)
    return data
  }
  return {
    details: () => call('admin_receipt_details'),
    saveDetails: details => call('admin_save_receipt_details', { p_details: { name: details.name, phone: details.phone || null, email: details.email || null, address: details.address || null, closing: details.closing || null } }),
    issue: bookingId => call('admin_issue_receipt', { p_booking_id: bookingId }),
    // The receipt that already exists for a booking, or nothing. Never makes one.
    get: bookingId => call('admin_get_receipt', { p_booking_id: bookingId }),
    edit: (bookingId, changes) => call('admin_edit_receipt', { p_booking_id: bookingId, p_changes: changes }),
    email: (bookingId, requestId) => call('admin_email_receipt', { p_booking_id: bookingId, p_request_id: requestId }),
  }
}
export const receiptsApi = createReceiptsApi(supabase)
