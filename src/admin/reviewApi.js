import { supabase } from '../lib/supabase.js'
import { STANDARD_REVIEW_MESSAGE } from './reviewInvite.js'

const SAFE_MESSAGES = new Set([
  'The review link must start with https:// and have no spaces',
  'Add your review link before asking automatically',
  'The review message can be up to 1000 characters',
  'Only the blanks listed can be used, each in curly brackets',
  'The message needs the {link} blank, so clients can find your review page',
])
// Until the database update for it is made (20261208100000_google_review_invites.sql), nothing here is switched on.
const missing = error => ['PGRST202', 'PGRST205', '42P01', '42883'].includes(error?.code) || /client_review_requests|admin_save_review_settings|admin_mark_review_asked|admin_clear_review_asked/.test(error?.message || '')
export const NOT_SWITCHED_ON = 'Google reviews are not switched on yet: the database update for them still has to be applied.'
function failure(error) {
  if (SAFE_MESSAGES.has(error?.message)) return new Error(`${error.message}.`)
  if (missing(error)) return Object.assign(new Error(NOT_SWITCHED_ON), { notSwitchedOn: true })
  return new Error('Could not save. Please check your connection and try again.')
}

// The review settings live in the business settings (the Admin can read them) and change only through the database function that checks them.
export function createReviewApi(client) {
  return {
    // { link, message ('' = standard), auto }
    settings: async () => {
      const { data, error } = await client.from('business_settings').select('key,value').in('key', ['google_review_link', 'review_message', 'review_auto'])
      if (error) throw new Error('Could not load your review settings. Please try again.')
      const value = key => data?.find(row => row.key === key)?.value
      return { link: typeof value('google_review_link') === 'string' ? value('google_review_link') : '', message: typeof value('review_message') === 'string' ? value('review_message') : '', auto: value('review_auto') === true }
    },
    save: async ({ link, message, auto }) => {
      const text = String(message || '').trim()
      const { error } = await client.rpc('admin_save_review_settings', { p_link: String(link || '').trim() || null, p_message: text && text !== STANDARD_REVIEW_MESSAGE ? text : null, p_auto: Boolean(auto) })
      if (error) throw failure(error)
    },
    // Whether this client was asked already: { asked_at, channel } or null.
    asked: async clientId => {
      const { data, error } = await client.from('client_review_requests').select('asked_at,channel').eq('client_id', clientId).maybeSingle()
      if (error) throw failure(error)
      return data || null
    },
    markAsked: async (bookingId, channel) => {
      const { data, error } = await client.rpc('admin_mark_review_asked', { p_booking_id: bookingId, p_channel: channel })
      if (error) throw failure(error)
      return { asked_at: data, channel }
    },
    clearAsked: async clientId => {
      const { error } = await client.rpc('admin_clear_review_asked', { p_client_id: clientId })
      if (error) throw failure(error)
    },
  }
}
export const reviewApi = createReviewApi(supabase)
