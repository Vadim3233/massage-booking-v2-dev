import { supabase } from '../lib/supabase.js'

// The Google Calendar settings page's reads and actions. The status and Resync now are database functions for the Admin; connecting and
// disconnecting go through the server (/api/google-calendar), which holds the Google codes, with the Admin's own sign-in.
const plain = message => new Error(message)

export function createGoogleCalendarApi(client, fetchImpl = (...args) => fetch(...args)) {
  async function withSignIn(method, action) {
    const { data } = await client.auth.getSession()
    const token = data?.session?.access_token
    if (!token) throw plain('Sign in again, then try once more.')
    let response
    try { response = await fetchImpl(`/api/google-calendar?action=${action}`, { method, headers: { authorization: `Bearer ${token}` } }) } catch { throw plain('Could not reach the server. Check your connection and try again.') }
    if (response.status === 503) throw plain('Google Calendar is not set up yet: the two Google codes still need adding in Vercel (see the setup guide).')
    if (!response.ok) throw plain('That did not work. Please try again.')
    return response.json()
  }
  return {
    status: async () => {
      const { data, error } = await client.rpc('admin_calendar_status')
      if (error) throw plain(error.code === 'PGRST202' || /admin_calendar_status/.test(error.message || '') ? 'Google Calendar needs a database update first.' : 'Could not load the calendar status. Please try again.')
      return data
    },
    connectUrl: async () => (await withSignIn('GET', 'start')).url,
    disconnect: () => withSignIn('POST', 'disconnect'),
    resync: async () => {
      const { error } = await client.rpc('admin_calendar_resync')
      if (error) throw plain('Could not start a resync. Please try again.')
    },
  }
}
export const googleCalendarApi = createGoogleCalendarApi(supabase)

// What Google's return to the page means, in words (the page's address says ?calendar=…).
export const RETURN_MESSAGES = {
  connected: ['status', 'Connected. Your bookings are being copied in now; it can take a few minutes the first time.'],
  cancelled: ['alert', 'Google Calendar was not connected: the Google sign-in was cancelled.'],
  expired: ['alert', 'That took too long, or was started somewhere else. Press Connect Google Calendar again.'],
  'no-access': ['alert', 'Google did not give access to the calendar. Press Connect again and tick the box that allows it to make and change its own calendar.'],
  error: ['alert', 'Google Calendar could not be connected. Please try again.'],
}
