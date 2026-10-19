import { supabase } from '../lib/supabase.js'
import { STANDARD_SHARE_MESSAGE } from './shareBooking.js'

const SAFE_MESSAGES = new Set(['The share message can be up to 1000 characters', 'Only the blanks listed can be used, each in curly brackets'])
function failure(error) {
  if (SAFE_MESSAGES.has(error?.message)) return new Error(`${error.message}.`)
  // Until the database update for it is made, there is nothing to save with.
  if (error?.code === 'PGRST202' || /admin_save_share_message/.test(error?.message || '')) return new Error('Saving your own wording is not switched on yet.')
  return new Error('Could not save. Please check your connection and try again.')
}

// The share message wording: read from the business settings (the Admin can read them), changed only through the database function that checks it.
export function createShareMessageApi(client) {
  return {
    // The saved wording, or '' for the standard one.
    get: async () => {
      const { data, error } = await client.from('business_settings').select('value').eq('key', 'share_message').maybeSingle()
      if (error) throw new Error('Could not load the share message. Please try again.')
      return typeof data?.value === 'string' ? data.value : ''
    },
    // The standard wording is kept as nothing, so a later change to it reaches the message too.
    save: async text => {
      const value = text.trim()
      const { error } = await client.rpc('admin_save_share_message', { p_text: value && value !== STANDARD_SHARE_MESSAGE ? value : null })
      if (error) throw failure(error)
    },
  }
}
export const shareMessageApi = createShareMessageApi(supabase)
