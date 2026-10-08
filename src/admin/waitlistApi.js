import { supabase } from '../lib/supabase.js'
import { clock } from './scheduleApi.js'

const SAFE = new Set(['This request is already closed', 'Choose what to do with this request', 'Please keep the note under 500 characters'])
const GENERIC = 'Could not complete that. Please check your connection and try again.'

export const windowText = (from, to) => from === 0 && to === 1440 ? 'Any time of day' : `${clock(from)} to ${clock(to)}`

export const waitlistActions = request => request.status === 'closed' ? []
  : request.status === 'offered' ? ['reopen', 'booked', 'not_needed'] : ['offered', 'booked', 'not_needed']
export const waitlistLabels = { offered: "I've offered a time", reopen: 'Not answered yet', booked: 'They are booked', not_needed: 'No longer needed' }

export function createWaitlistApi(client) {
  async function call(name, args) {
    const { data, error } = await client.rpc(name, args)
    if (error) throw new Error(SAFE.has(error.message) ? error.message : GENERIC)
    return data
  }
  return {
    list: includeClosed => call('admin_waitlist', { p_include_closed: Boolean(includeClosed) }),
    update: (id, action, note) => call('admin_update_waitlist', { p_id: id, p_action: action, p_note: note || null }),
  }
}
export const waitlistApi = createWaitlistApi(supabase)
