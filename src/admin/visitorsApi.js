import { supabase } from '../lib/supabase.js'

// The Visitors page's read and the evening-hours setting (ADR-095). The database keeps the visits; the page works out the sums.
export function createVisitorsApi(client) {
  async function run(request, what) {
    const { data, error } = await request
    if (error) throw new Error(error.code === 'PGRST202' ? 'Visitors needs a database update first.' : error.code === '22023' ? error.message : `Could not ${what}. Please try again.`)
    return data
  }
  return {
    visits: (from, to) => run(client.rpc('admin_visits', { p_from: from, p_to: to }), 'load the visits').then(rows => (rows || []).map(row => ({ ...row, events: row.events || [] }))),
    eveningHours: () => run(client.rpc('admin_wanted_evening_hours'), 'load the setting'),
    saveEveningHours: hours => run(client.rpc('admin_save_wanted_evening_hours', { p_hours: hours }), 'save the setting'),
    // Booking several sessions (ADR-097): whether a client's later sessions are confirmed automatically.
    autoConfirmLater: () => run(client.rpc('admin_auto_confirm_later_sessions'), 'load the setting'),
    saveAutoConfirmLater: on => run(client.rpc('admin_save_auto_confirm_later_sessions', { p_on: on }), 'save the setting'),
  }
}
export const visitorsApi = createVisitorsApi(supabase)
