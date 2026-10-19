import { dateLabel, shiftDate, time } from './calendarPresentation.js'
import { clock, hoursLine } from './scheduleApi.js'

// What the Agenda lists, in order. Days with bookings are shown in full, as they always were. Around them come the things that change the diary
// without being a booking: time away (a block over several days or a whole day), a special day (a day off, or different hours), a few hours
// blocked on one day, and, when "Show every day" is on, every day with nothing on it, one quiet line each. Every day says its working hours, as the
// database works them out (admin_day_hours: its special day, or else the usual week), so the Agenda never shows hours clients cannot book.

const isAllDay = row => row.start_minutes === 0 && row.end_minutes === 1440
const push = (map, key, value) => map.set(key, [...(map.get(key) || []), value])
const everyDate = (start, end) => { const dates = []; for (let date = start; date < end; date = shiftDate(date, 1)) dates.push(date); return dates }

// The rows of one block share a group_id. A block over several days has a row for each day.
function groupsOf(blocks) {
  const groups = new Map()
  for (const row of blocks) push(groups, row.group_id ?? row.id, row)
  return [...groups.entries()].map(([key, rows]) => {
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.start_minutes - b.start_minutes)
    const first = sorted[0], last = sorted.at(-1)
    return { key, rows: sorted, first, last, from: first.date, to: last.date, dates: [...new Set(sorted.map(row => row.date))] }
  })
}
// A block over several days, or over a whole day, is time away and gets a banner. A few hours on one day belong to that day.
const isAway = group => group.from !== group.to || isAllDay(group.first)

export const blockTitle = row => row.title || (row.kind === 'personal_event' ? 'Personal event' : 'Blocked time')
export const blockHeading = group => group.first.kind === 'personal_event' ? blockTitle(group.first) : `Away${group.first.title ? ` · ${group.first.title}` : ''}`
// "Tue 22 Dec to Wed 30 Dec · 9 days", or "Tue 22 Dec · all day". A time is added only where the block does not start or end at midnight.
export function blockSpan(group) {
  const { first, last, from, to, dates } = group
  const begins = `${dateLabel(from)}${first.start_minutes > 0 ? ` ${clock(first.start_minutes)}` : ''}`
  if (from === to) return `${begins} · all day`
  const ends = `${dateLabel(to)}${last.end_minutes < 1440 ? ` ${clock(last.end_minutes)}` : ''}`
  return `${begins} to ${ends} · ${dates.length} days`
}
export const specialLine = entry => `${entry.available ? `Special hours ${hoursLine(entry)}` : 'Day off'}${entry.note ? ` · ${entry.note}` : ''}`
// A day's hours in words, whatever kind of day it is: special hours or a special day off as above, usual hours, or a usual day off.
export const dayHoursLine = hours => !hours ? '' : hours.source === 'special' ? specialLine(hours) : hours.available ? `Hours ${hoursLine(hours)}` : 'Day off'
const timedLine = row => `${time(row.start_minutes)}–${time(row.end_minutes)} · ${blockTitle(row)}`

// A day's own list: its bookings and its timed blocks, in time order (a booking comes first when they start together).
const dayRows = (bookings, timed) => [
  ...bookings.map(booking => ({ kind: 'booking', start: booking.start_minutes, booking })),
  ...timed.map(row => ({ kind: 'block', start: row.start_minutes, row })),
].sort((a, b) => a.start - b.start)

// The Agenda reads blocks and each day's hours a month at a time, like the bookings; a block over two months comes back in both.
export function mergeExtras(lists) {
  const blocks = new Map()
  const hours = new Map()
  for (const list of lists) {
    for (const row of list.blocks || []) blocks.set(row.id, row)
    for (const entry of list.hours || []) hours.set(entry.date, entry)
  }
  return { blocks: [...blocks.values()], hours: [...hours.values()].sort((a, b) => a.date.localeCompare(b.date)) }
}
// How many special days a month read found, so the Agenda can tell a month with something in it from an empty one.
export const specialCount = extras => (extras.hours || []).filter(entry => entry.source === 'special').length

// start is the first day on show and end the day after the last. day is today, which is always on show, even when nothing is booked,
// so there is always a fixed point to scroll from.
export function agendaDays({ bookings, blocks = [], hours = [], start, end, day, showEvery = false }) {
  const inRange = date => date >= start && date < end
  const byDate = new Map()
  for (const booking of bookings) push(byDate, booking.date, booking)
  const hoursOn = new Map(hours.map(entry => [entry.date, entry]))
  const specials = new Map(hours.filter(entry => entry.source === 'special' && inRange(entry.date)).map(entry => [entry.date, entry]))
  const groups = groupsOf(blocks)
  const timed = new Map()
  for (const group of groups.filter(group => !isAway(group))) for (const row of group.rows) if (inRange(row.date)) push(timed, row.date, row)
  // The days an away block covers, and which day of it each is. Its banner stands at the first of them on show.
  const covered = new Map()
  const bannerAt = new Map()
  for (const group of groups.filter(isAway)) {
    const shown = group.dates.filter(inRange)
    for (const date of shown) covered.set(date, { group, number: group.dates.indexOf(date) + 1 })
    if (shown.length) push(bannerAt, shown[0], group)
  }
  const wanted = showEvery ? everyDate(start, end) : [...byDate.keys(), ...specials.keys(), ...timed.keys(), ...bannerAt.keys()]
  const dates = [...new Set([...wanted, ...(day >= start ? [day] : [])])].sort()

  const raw = []
  const quiet = (date, kind, text, row) => ({ type: 'quiet', id: `${date}-${kind}-${raw.length}`, date, kind, text, row: row || null })
  for (const date of dates) {
    for (const group of bannerAt.get(date) || []) raw.push({ type: 'away', date, group })
    const cover = covered.get(date)
    const booked = byDate.get(date) || []
    if (booked.length || date === day) {
      raw.push({ type: 'day', date, bookings: booked, rows: dayRows(booked, timed.get(date) || []), hours: hoursOn.get(date) || null, special: specials.get(date) || null, away: cover?.group || null })
      continue
    }
    // The banner already stands for the first day of the block, and, with Show every day off, for all of its days.
    if (bannerAt.has(date)) continue
    if (cover) {
      if (showEvery) raw.push(quiet(date, 'away', `${blockHeading(cover.group)} · day ${cover.number} of ${cover.group.dates.length}`, cover.group.first))
      continue
    }
    const special = specials.get(date)
    const blocked = timed.get(date) || []
    if (special) raw.push(quiet(date, special.available ? 'special' : 'off', specialLine(special)))
    for (const row of blocked) raw.push(quiet(date, 'block', timedLine(row), row))
    const own = hoursOn.get(date)
    if (showEvery && !special && !blocked.length) raw.push(own && !own.available ? quiet(date, 'closed', 'usual day off') : quiet(date, 'free', own ? `free · ${hoursLine(own)}` : 'free'))
  }

  // Quiet lines that follow each other are one list, so a screen reader meets one list, not a heading for every empty day.
  const entries = []
  for (const item of raw) {
    if (item.type !== 'quiet') { entries.push(item); continue }
    const last = entries.at(-1)
    if (last?.type === 'quiet') last.items.push(item)
    else entries.push({ type: 'quiet', key: `quiet-${item.id}`, items: [item] })
  }
  return entries
}
