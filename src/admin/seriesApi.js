import { supabase } from '../lib/supabase.js'

export { DAY_NAMES, dayName, describeRepeat } from './repeatPattern.js'

// Messages written for the Admin on the server. Anything else becomes a generic line.
const SAFE_MESSAGES = new Set([
  'That session is already booked. Cancel the booking instead.',
  'That date cannot be put back',
  'This repeat has ended',
  'The repeat cannot end before it starts',
  'A repeat can run for up to three years',
  'Choose between 1 and 30 days',
  "That date is not one of this repeat's dates",
  'Only dates still to come can be cancelled',
  'Choose between 1 and 60 dates',
])
const GENERIC = 'Could not complete that. Please check your connection and try again.'
const failure = error => new Error(SAFE_MESSAGES.has(error?.message) ? error.message : GENERIC)

export const SKIP_LABELS = { skipped: 'Skipped', cancelled: 'Cancelled', moved: 'Moved to another day', clash: 'Not booked: the time was taken' }
export const validReminderDays = value => /^[0-9]{1,2}$/.test(String(value).trim()) && Number(value) >= 1 && Number(value) <= 30
export const canPutBack = reason => reason === 'skipped' || reason === 'clash'
// A booking that is still to come and can be cancelled from the repeat (one that has happened, or been missed, is left as it is).
export const CANCELLABLE = ['awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed']

export function createSeriesApi(client) {
  async function run(request) {
    const { data, error } = await request
    if (error) throw failure(error)
    return data
  }
  return {
    list: clientId => run(client.rpc('admin_client_series', { p_client_id: clientId })),
    setStatus: (id, status) => run(client.rpc('admin_set_series_status', { p_series_id: id, p_status: status })),
    skip: (id, date) => run(client.rpc('admin_skip_series_date', { p_series_id: id, p_date: date })),
    unskip: (id, date) => run(client.rpc('admin_unskip_series_date', { p_series_id: id, p_date: date })),
    // Some dates of a repeat: a booked one is cancelled (the client is emailed, no late fee), a date only held is skipped. The repeat goes on.
    cancelDates: (id, dates, requestId = crypto.randomUUID()) => run(client.rpc('admin_series_cancel_dates', { p_series_id: id, p_dates: dates, p_request_id: requestId })),
    // Everything still to come is cancelled, and the repeat ends.
    cancelAllUpcoming: (id, requestId = crypto.randomUUID()) => run(client.rpc('admin_series_cancel_all_upcoming', { p_series_id: id, p_request_id: requestId })),
    reminderDays: () => run(client.rpc('admin_series_reminder_days')),
    saveReminderDays: days => run(client.rpc('admin_set_series_reminder_days', { p_days: days })),
  }
}
export const seriesApi = createSeriesApi(supabase)
