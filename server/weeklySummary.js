// The Monday "Your week" message (ADR-103, supabase/migrations/20261213100000_busy_times.sql). When it is switched on, the database says from
// 08:00 London time on a Monday that the week's message is due and hands over the facts; this writes the text with the same counting as the
// Income page's Busiest times (src/admin/busyTimes.js) and queues it once. The usual sender then delivers it to the Admin's Telegram.
import { weeklyText } from '../src/admin/busyTimes.js'

export async function planWeeklySummary({ client }) {
  const { data, error } = await client.rpc('weekly_summary_due')
  // Before the database change is applied, or when it is not due, there is nothing to do.
  if (error || !data) return { due: false }
  const text = weeklyText(data)
  const { data: queued, error: failed } = await client.rpc('queue_weekly_summary', { p_week: data.today, p_body: text || '' })
  if (failed) return { due: true, failed: true }
  return { due: true, queued: Boolean(queued) }
}
