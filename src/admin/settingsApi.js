import { supabase } from '../lib/supabase.js'

const SAFE = new Set([
  'Enter the name on the account', 'The sort code needs six digits', 'The account number needs eight digits', 'That is too long',
  'Booking ahead must be between 1 and 365 days', 'Notice must be between 0 and 72 hours', 'The free cancellation window must be between 0 and 168 hours',
  'The grace period must be between 0 and 240 minutes', 'A new client may hold between 1 and 10 bookings', 'A returning client may hold as many as a new client, up to 20',
  'Every rule needs a whole number',
])
const GENERIC = 'Could not save. Please check your connection and try again.'

export function validateBank(details) {
  if (!details.account_name.trim()) return 'Enter the name on the account.'
  if (details.sort_code.replace(/[^0-9]/g, '').length !== 6) return 'The sort code needs six digits, for example 12-34-56.'
  if (details.account_number.replace(/[^0-9]/g, '').length !== 8) return 'The account number needs eight digits.'
  return ''
}

export const RULE_FIELDS = [
  { key: 'booking_horizon_days', label: 'How many days ahead clients can book', hint: 'From 1 to 365 days. Your own bookings in Admin are not limited by this.', min: 1, max: 365 },
  { key: 'minimum_notice_hours', label: 'Hours of notice clients need', hint: 'From 0 to 72 hours. A booking cannot start sooner than this.', min: 0, max: 72 },
  { key: 'free_cancellation_hours', label: 'Free to cancel or change up to this many hours before', hint: 'From 0 to 168 hours. Inside this the full price is recorded as a late fee, which you can reduce or waive.', min: 0, max: 168 },
  { key: 'grace_minutes', label: 'Minutes after booking when changes are always free', hint: 'From 0 to 240 minutes. For a booking made by mistake, whatever the appointment time.', min: 0, max: 240 },
  { key: 'new_client_booking_limit', label: 'Upcoming bookings a new client may hold', hint: 'From 1 to 10. A client is new until they have a completed, paid appointment.', min: 1, max: 10 },
  { key: 'returning_client_booking_limit', label: 'Upcoming bookings a returning client may hold', hint: 'At least as many as a new client, up to 20.', min: 1, max: 20 },
]

// The same ranges the database enforces, so a slip is caught with a plain sentence first.
export function validateRules(values) {
  for (const field of RULE_FIELDS) {
    const text = String(values[field.key] ?? '').trim()
    if (!/^\d{1,4}$/.test(text)) return `${field.label}: enter a whole number.`
    const number = Number(text)
    if (number < field.min || number > field.max) return `${field.label}: choose a number from ${field.min} to ${field.max}.`
  }
  if (Number(values.returning_client_booking_limit) < Number(values.new_client_booking_limit)) return 'A returning client should be allowed at least as many bookings as a new client.'
  return ''
}

export function createSettingsApi(client) {
  async function call(name, args) {
    const { data, error } = await client.rpc(name, args)
    if (error) throw new Error(SAFE.has(error.message) ? error.message : GENERIC)
    return data
  }
  return {
    bank: () => call('admin_bank_details'),
    rules: () => call('admin_booking_rules'),
    saveRules: values => call('admin_save_booking_rules', { p_rules: Object.fromEntries(RULE_FIELDS.map(field => [field.key, Number(values[field.key])])) }),
    saveBank: details => call('admin_save_bank_details', { p_account_name: details.account_name, p_bank_name: details.bank_name || null, p_sort_code: details.sort_code, p_account_number: details.account_number, p_note: details.note || null }),
  }
}
export const settingsApi = createSettingsApi(supabase)
