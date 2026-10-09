import { supabase } from '../lib/supabase.js'

export function createAlertsApi(client) {
  async function call(name, args) {
    const { data, error } = await client.rpc(name, args)
    if (error) throw new Error('Could not load your alerts. Please retry.')
    return data
  }
  return {
    list: (limit = 50) => call('admin_list_notifications', { p_limit: limit }),
    unread: async () => Number(await call('admin_unread_notification_count')),
    markRead: ids => call('admin_mark_notifications_read', { p_ids: ids ?? null }),
  }
}
export const alertsApi = createAlertsApi(supabase)

// The booking an alert points at, from its link. Alerts only ever link to pages inside this app.
export const bookingIdFromLink = link => (/^\/admin\/bookings\/([0-9a-f-]{36})$/i.exec(link || '') || [])[1] || null
