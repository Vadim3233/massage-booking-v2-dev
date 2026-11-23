import { clock } from './scheduleApi.js'

// Quick hours (ADR-112): a day's hours changed with two drop-downs from Hours only, saved through the same command as the Edit hours grid
// (admin_save_day_grid), so the database still refuses what a booking needs. The half hours the grid locks (a booking, its travel, named blocked
// time) stay exactly as they are; closed half hours already inside the old hours (a short break) stay closed; everything else follows the times picked.
export function quickPlan(rows, start, end) {
  const dayOff = start == null
  const inside = minutes => !dayOff && minutes >= start && minutes < end
  const was = rows.filter(row => row.open).map(row => row.start_minutes)
  const [oldFrom, oldTo] = was.length ? [Math.min(...was), Math.max(...was) + 30] : [null, null]
  const open = rows.filter(row => {
    if (row.locked) return row.open
    if (!inside(row.start_minutes)) return false
    return oldFrom != null && row.start_minutes >= oldFrom && row.start_minutes < oldTo ? row.open : true
  }).map(row => row.start_minutes)
  // What the day will really be once saved: from the first open half hour to the end of the last.
  const result = open.length ? { from: Math.min(...open), to: Math.max(...open) + 30 } : null
  const bookings = [...new Map(rows.filter(row => row.locked === 'booking' && row.open && !inside(row.start_minutes))
    .map(row => [row.booking_id, `${row.label || 'a client'} at ${clock(row.booking_times?.[0] ?? row.start_minutes)}`])).values()]
  let note = ''
  if (dayOff && result) note = bookings.length ? `You have a booking that day (${bookings.join(', ')}), so it cannot be a day off. Move or cancel it first.` : ''
  else if (!dayOff && result && (result.from !== start || result.to !== end)) {
    note = `${bookings.length ? `Your booking with ${bookings.join(', ')} stays` : 'A booking and its travel time stay'}, so the day runs ${clock(result.from)}–${clock(result.to)}. Nothing new can be booked outside ${clock(start)}–${clock(end)}.`
  }
  const unchanged = open.length === was.length && open.every(minutes => was.includes(minutes))
  return { open, result, note, blocked: dayOff && Boolean(result), unchanged }
}
