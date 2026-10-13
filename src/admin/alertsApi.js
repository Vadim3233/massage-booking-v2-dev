import { supabase } from '../lib/supabase.js'
import { dateLabel, shiftDate, today } from './calendarPresentation.js'

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

// A booking often raises two alerts at once (a new request, then "the transfer is made"). They read better as one card:
// the newest on top, the others named beneath it. Alerts that point anywhere else stay on their own.
export function groupAlerts(alerts) {
  const groups = []
  const byBooking = new Map()
  for (const alert of alerts) {
    const key = bookingIdFromLink(alert.link_path)
    let group = key && byBooking.get(key)
    if (!group) {
      group = { id: alert.id, head: alert, older: [], ids: [] }
      groups.push(group)
      if (key) byBooking.set(key, group)
    } else group.older.push(alert)
    group.ids.push(alert.id)
  }
  return groups.map(group => ({ ...group, unreadIds: [group.head, ...group.older].filter(alert => !alert.read_at).map(alert => alert.id) }))
}

// The London date an alert was raised on.
const londonDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value))
// What a day's heading says: Today and Yesterday by name, then the date.
export function alertDayHeading(date, from = today()) {
  const short = dateLabel(date, { weekday: 'short', day: 'numeric', month: 'short' })
  if (date === from) return { name: 'Today', rest: short }
  if (date === shiftDate(from, -1)) return { name: 'Yesterday', rest: short }
  return { name: dateLabel(date, { weekday: 'short', day: 'numeric', month: 'short', ...(date.slice(0, 4) === from.slice(0, 4) ? {} : { year: 'numeric' }) }), rest: '' }
}
// The cards under the day they were raised on, newest day first, so a day can be found by scrolling and its heading stays in sight.
// The cards come newest first, so each day's cards are together.
export function groupByDay(groups, from = today()) {
  const days = []
  for (const group of groups) {
    const date = londonDay(group.head.created_at)
    let day = days.at(-1)
    if (day?.date !== date) { day = { date, ...alertDayHeading(date, from), groups: [], unread: 0 }; days.push(day) }
    day.groups.push(group)
    if (group.unreadIds.length) day.unread += 1
  }
  return days
}
