import { supabase } from '../lib/supabase.js'
import { createAlertsApi } from './alertsApi.js'
import { createLifecycleApi } from './bookingLifecycleApi.js'

// The record behind the Alerts page and every booking's History (ADR-107): what happened, when, and who did it.
// Before the database change (20261220100000_activity_record.sql) is applied, the Alerts page shows the alerts as before and a booking's
// History shows the status changes and moves it always had, so nothing breaks in between.

const missing = error => ['PGRST202', '42883'].includes(error?.code) || /admin_activity_list|admin_booking_activity|admin_client_moves|admin_note_last_event/.test(error?.message || '')

// An old alert, in the shape of a line of the record: a client did something, and it raised the alert.
export const lineFromAlert = alert => ({
  id: alert.id, event_type: 'alert', at: alert.created_at, actor: 'client', payload: {}, name: null,
  booking_id: (/^\/admin\/bookings\/([0-9a-f-]{36})$/i.exec(alert.link_path || '') || [])[1] || null,
  alert_id: alert.id, alert_title: alert.title, alert_body: alert.body, alert_link: alert.link_path, alert_read_at: alert.read_at,
})

// A status change or a move from the booking's old history, in the same shape.
export const lineFromOldHistory = (row, index) => row.kind === 'schedule'
  ? { id: `old-${index}`, event_type: 'booking.rescheduled', at: row.occurred_at, actor: row.actor_type, payload: { from_date: row.from_date, from_start_minutes: row.from_start_minutes, to_date: row.to_date, to_start_minutes: row.to_start_minutes } }
  : { id: `old-${index}`, event_type: 'status.changed', at: row.occurred_at, actor: row.actor_type, payload: { entity: row.kind, from_status: row.from_status, to_status: row.to_status } }

export function createActivityApi(client, alerts = createAlertsApi(client), lifecycle = createLifecycleApi(client)) {
  async function call(name, args, what) {
    const { data, error } = await client.rpc(name, args)
    if (error) {
      const failure = new Error(`Could not load ${what}. Please retry.`)
      failure.missing = missing(error)
      throw failure
    }
    return data
  }
  return {
    // Newest first. `before` is the last line already shown ({ at, id }), for "Show older".
    async list({ filter = 'all', search = '', before = null, limit = 50 } = {}) {
      try {
        const rows = await call('admin_activity_list', { p_filter: filter, p_search: search || null, p_before_at: before?.at ?? null, p_before_id: before?.id ?? null, p_limit: limit }, 'your alerts')
        return { rows: rows || [], full: true }
      } catch (failure) {
        if (!failure.missing) throw failure
        // Not applied yet: the alerts, as before. "Show older" and the filters other than Needs you have nothing more to show.
        if (before) return { rows: [], full: false }
        const lines = (await alerts.list(limit)).map(lineFromAlert)
        const wanted = filter === 'new' ? lines.filter(line => !line.alert_read_at) : lines
        const needle = search.trim().toLowerCase()
        return { rows: needle ? wanted.filter(line => `${line.alert_title} ${line.alert_body}`.toLowerCase().includes(needle)) : wanted, full: false }
      }
    },
    // One booking's whole story, oldest first.
    async booking(bookingId) {
      try { return await call('admin_booking_activity', { p_booking_id: bookingId }, 'the history') } catch (failure) {
        if (!failure.missing) throw failure
        return (await lifecycle.history(bookingId)).map(lineFromOldHistory)
      }
    },
    // How many of the client's last bookings they asked to move. Nothing shows if it cannot be read.
    clientMoves: clientId => call('admin_client_moves', { p_client_id: clientId }, 'the moves'),
    // Vadim's "why" for the move he has just made. The move is saved either way.
    noteLast: (bookingId, eventType, note) => call('admin_note_last_event', { p_booking_id: bookingId, p_event_type: eventType, p_note: note }, 'the note'),
    markRead: alerts.markRead,
  }
}
export const activityApi = createActivityApi(supabase)
