import { clock } from './scheduleApi.js'

// A day as half-hour blocks (ADR-080). The database says what each half hour is (admin_day_grid): open or not, and whether a booking, its travel
// time or blocked time the grid does not own locks it. These helpers only lay that out and count what the Admin has tapped.

// The rows as they would be with the taps applied. `edits` maps a half hour's start to the state it was tapped to; locked half hours never change.
export function applyEdits(rows, edits) {
  return rows.map(row => {
    const open = !row.locked && row.start_minutes in edits ? edits[row.start_minutes] : row.open
    return { ...row, open, changed: open !== row.open }
  })
}

export const changeCount = rows => rows.filter(row => row.changed).length

// What is shown: the day's hours (and anything locked) with an hour either side, or the whole day on either side when asked. A day with nothing
// open or locked shows 08:00 to 22:00, so there is something to tap.
export function visibleRange(rows, { earlier = false, later = false } = {}) {
  const used = rows.filter(row => row.open || row.locked)
  let from = used.length ? Math.max(0, used[0].start_minutes - 60) : 480
  let to = used.length ? Math.min(1440, used.at(-1).start_minutes + 90) : 1320
  if (earlier) from = 0
  if (later) to = 1440
  return { from, to, moreEarlier: from > 0, moreLater: to < 1440 }
}

// The open time as runs: [[870, 960], [1020, 1260]].
export function openRuns(rows) {
  const runs = []
  for (const row of rows) {
    if (!row.open) continue
    const last = runs.at(-1)
    if (last && last[1] === row.start_minutes) last[1] += 30
    else runs.push([row.start_minutes, row.start_minutes + 30])
  }
  return runs
}

export function hoursSummary(rows) {
  const runs = openRuns(rows)
  return runs.length ? runs.map(([from, to]) => `${clock(from)}–${clock(to)}`).join(', ') : 'Day off'
}

// Day off: no half hour that can be tapped is open. A booking keeps its own time either way.
export const isDayOff = rows => !rows.some(row => row.open && !row.locked)

// Every half hour the Admin can tap, closed: what the Day off switch does.
export function closeAll(rows) {
  return Object.fromEntries(rows.filter(row => !row.locked).map(row => [row.start_minutes, false]))
}

// A booking or blocked time is named once, on its first half hour on screen. A booking also says its times, so its last half hour is not
// mistaken for the one after it: "Andreas · 17:30–19:30".
export function withLabels(rows) {
  return rows.map((row, index) => {
    const before = rows[index - 1]
    const first = row.label && !(before && before.label === row.label && before.locked === row.locked)
    if (!first) return { ...row, showLabel: '' }
    if (row.locked !== 'booking') return { ...row, showLabel: row.label }
    const own = rows.filter(other => other.locked === 'booking' && other.booking_id === row.booking_id)
    const [from, to] = row.booking_times || [own[0].start_minutes, own.at(-1).start_minutes + 30]
    return { ...row, showLabel: `${row.label} · ${clock(from)}–${clock(to)}` }
  })
}

// What the database is sent: every open half hour.
export const openMinutes = rows => rows.filter(row => row.open).map(row => row.start_minutes)

// How a held time is described when the Admin is asked about closing it.
export function heldLine(minutes) {
  return openRuns(minutes.map(start_minutes => ({ start_minutes, open: true }))).map(([from, to]) => `${clock(from)}–${clock(to)}`).join(', ')
}
