import { supabase } from '../lib/supabase.js'
import { time } from './calendarPresentation.js'

// Messages written for the Admin on the server. Anything else becomes a generic line.
const SAFE_MESSAGES = new Set([
  'That session is already booked. Cancel the booking instead.',
  'That date cannot be put back',
  'This repeat has ended',
  'The repeat cannot end before it starts',
  'A repeat can run for up to three years',
  'Choose between 1 and 30 days',
])
const GENERIC = 'Could not complete that. Please check your connection and try again.'
const failure = error => new Error(SAFE_MESSAGES.has(error?.message) ? error.message : GENERIC)

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
export const dayName = date => DAY_NAMES[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7]
export const describeRepeat = series => `Every ${DAY_NAMES[series.weekday - 1]} at ${time(series.start_minutes)} · ${series.treatment_duration_minutes} min`
export const SKIP_LABELS = { skipped: 'Skipped', cancelled: 'Cancelled', moved: 'Moved to another day', clash: 'Not booked: the time was taken' }
export const validReminderDays = value => /^[0-9]{1,2}$/.test(String(value).trim()) && Number(value) >= 1 && Number(value) <= 30
export const canPutBack = reason => reason === 'skipped' || reason === 'clash'

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
    reminderDays: () => run(client.rpc('admin_series_reminder_days')),
    saveReminderDays: days => run(client.rpc('admin_set_series_reminder_days', { p_days: days })),
  }
}
export const seriesApi = createSeriesApi(supabase)
