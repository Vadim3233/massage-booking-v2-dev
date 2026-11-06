// The Visitors page's sums and words (ADR-095). The database gives every visit with its steps in order (admin_visits); everything shown is worked
// out here, so it can be tested without a browser.
import { dateLabel, shiftDate, time } from './calendarPresentation.js'
import { PREFERENCE_LABELS } from '../client/booking/wantedTimes.js'

export const PERIODS = [['today', 'Today', 1], ['week', '7 days', 7], ['month', '30 days', 30]]

const londonDay = (stamp) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(stamp))
const londonClock = (stamp) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }).format(new Date(stamp))
const short = (date) => dateLabel(date, { weekday: 'short', day: 'numeric' })

// What a period covers, and the same length just before it, for "compared with".
export function periodRange(kind, today) {
  const days = PERIODS.find(([key]) => key === kind)?.[2] || 7
  const from = shiftDate(today, -(days - 1))
  return { days, from, to: today, previousFrom: shiftDate(from, -days), previousTo: shiftDate(from, -1) }
}

// How far a visit got, as one of the funnel's steps.
export const STAGES = ['Opened the app', 'Chose a treatment', 'Looked at times', 'Picked a time', 'Reached payment', 'Booked']
const STAGE_OF = { opened: 0, area: 0, treatment: 1, length: 1, day: 2, wanted: 2, asked: 2, time: 3, review: 3, details: 3, payment: 4, booked: 5 }
export const stageOf = (visit) => Math.max(0, ...visit.events.map((event) => STAGE_OF[event.kind] ?? 0))

const has = (visit, kind, test = () => true) => visit.events.some((event) => event.kind === kind && test(event.detail || {}))
const noFreeDay = (visit) => has(visit, 'day', (detail) => Number(detail.free) === 0)

// How a visit ended: booked, asked to hear about a time, found no time free, left at payment, or just looked.
export const OUTCOMES = { booked: 'Booked', asked: 'Asked to hear', no_time: 'No time free', payment: 'Left at payment', looked: 'Just looked' }
export function outcomeOf(visit) {
  if (has(visit, 'booked')) return 'booked'
  if (has(visit, 'asked')) return 'asked'
  if (stageOf(visit) >= 4) return 'payment'
  if (has(visit, 'wanted') || (noFreeDay(visit) && !has(visit, 'time'))) return 'no_time'
  return 'looked'
}

export function visitsIn(visits, from, to) {
  return visits.filter((visit) => { const day = londonDay(visit.started_at); return day >= from && day <= to })
}

// The three numbers at the top and the funnel under them.
export function summarize(visits) {
  const outcomes = visits.map(outcomeOf)
  const stages = visits.map(stageOf)
  return {
    opened: visits.length,
    booked: outcomes.filter((outcome) => outcome === 'booked').length,
    noTime: outcomes.filter((outcome) => outcome === 'no_time' || outcome === 'asked').length,
    funnel: STAGES.map((label, index) => ({ label, count: stages.filter((stage) => stage >= index).length })),
  }
}

export function changeText(now, before) {
  const difference = now - before
  if (difference === 0) return 'same as before'
  return `${difference > 0 ? '+' : '−'}${Math.abs(difference)}`
}

// The step where most people stopped, in a sentence. Nothing when nobody visited or nobody stopped.
export function biggestDrop(funnel) {
  let worst = null
  for (let index = 0; index < funnel.length - 1; index += 1) {
    const lost = funnel[index].count - funnel[index + 1].count
    if (lost > 0 && (!worst || lost > worst.lost)) worst = { lost, from: funnel[index], to: funnel[index + 1] }
  }
  if (!worst) return ''
  return `${worst.lost} of ${worst.from.count} stopped after “${worst.from.label.toLowerCase()}” and did not get to “${worst.to.label.toLowerCase()}”.`
}

// "Times people wanted but couldn't get": each faded time tapped (once per visit), by weekday and two-hour band.
export const BANDS = [[0, 600, 'Before 10'], [600, 720, '10–12'], [720, 840, '12–2'], [840, 960, '2–4'], [960, 1080, '4–6'], [1080, 1200, '6–8'], [1200, 1440, 'After 8']]
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const weekdayIndex = (date) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7
export function wantedTimes(visits) {
  const seen = new Set()
  const times = []
  for (const visit of visits) {
    for (const event of visit.events) {
      const detail = event.detail || {}
      if (!['wanted', 'asked'].includes(event.kind) || !Number.isInteger(detail.start) || !detail.date) continue
      const key = `${visit.visit_id}:${detail.date}:${detail.start}`
      if (seen.has(key)) continue
      seen.add(key)
      times.push({ date: detail.date, start: detail.start, visit })
    }
  }
  return times
}
export function wantedGrid(visits) {
  const cells = BANDS.map(() => WEEKDAYS.map(() => 0))
  for (const { date, start } of wantedTimes(visits)) {
    const band = BANDS.findIndex(([from, to]) => start >= from && start < to)
    if (band >= 0) cells[band][weekdayIndex(date)] += 1
  }
  return cells
}
export function busiestWanted(cells) {
  let best = null
  cells.forEach((row, band) => row.forEach((count, day) => { if (count > 0 && (!best || count > best.count)) best = { band, day, count } }))
  return best && { ...best, text: `${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][best.day]} ${BANDS[best.band][2].replace('–', ' to ')} was wanted ${best.count === 1 ? 'once' : `${best.count} times`} when it wasn't free.` }
}
export const shade = (count, most) => (count <= 0 || most <= 0 ? 0 : Math.min(4, Math.ceil((count / most) * 4)))

// "None of these suit me" answers, most common first.
export function preferences(visits) {
  const counts = new Map()
  for (const visit of visits) for (const event of visit.events) {
    const pref = event.kind === 'wanted' ? event.detail?.pref : null
    if (pref && PREFERENCE_LABELS[pref]) counts.set(pref, (counts.get(pref) || 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, label: PREFERENCE_LABELS[key], count }))
}

// Clients you know who got as far as looking at times and did not book: the latest visit of each, unless they booked in a later visit.
export function followUps(visits, limit = 8) {
  const byClient = new Map()
  const bookedAt = new Map()
  for (const visit of visits) {
    if (!visit.client_id) continue
    if (outcomeOf(visit) === 'booked') bookedAt.set(visit.client_id, Math.max(bookedAt.get(visit.client_id) || 0, Date.parse(visit.started_at)))
  }
  for (const visit of visits) {
    if (!visit.client_id || outcomeOf(visit) === 'booked' || stageOf(visit) < 2) continue
    if ((bookedAt.get(visit.client_id) || 0) > Date.parse(visit.started_at)) continue
    const known = byClient.get(visit.client_id)
    if (!known || Date.parse(visit.started_at) > Date.parse(known.started_at)) byClient.set(visit.client_id, visit)
  }
  return [...byClient.values()].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)).slice(0, limit)
}

export function lastBookedText(date, today) {
  if (!date) return 'no past bookings'
  const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86400000)
  if (days < 14) return `last booked ${days} ${days === 1 ? 'day' : 'days'} ago`
  if (days < 60) return `last booked ${Math.round(days / 7)} weeks ago`
  return `last booked ${dateLabel(date, { day: 'numeric', month: 'short', year: 'numeric' })}`
}

// One line on what a visit was after.
export function whatText(visit) {
  const minutes = visit.events.find((event) => event.detail?.minutes)?.detail.minutes
  const parts = []
  if (minutes) parts.push(`${minutes} min`)
  const asked = [...visit.events].reverse().find((event) => event.kind === 'asked')
  const wanted = [...visit.events].reverse().find((event) => event.kind === 'wanted' && Number.isInteger(event.detail?.start))
  const pref = [...visit.events].reverse().find((event) => event.kind === 'wanted' && event.detail?.pref)
  const picked = [...visit.events].reverse().find((event) => event.kind === 'time')
  const days = new Set(visit.events.filter((event) => event.kind === 'day').map((event) => event.detail?.date))
  const empty = new Set(visit.events.filter((event) => event.kind === 'day' && Number(event.detail?.free) === 0).map((event) => event.detail?.date))
  if (asked) parts.push(`asked about ${short(asked.detail.date)} at ${time(asked.detail.start)}`)
  else if (wanted) parts.push(`wanted ${short(wanted.detail.date)} at ${time(wanted.detail.start)}`)
  else if (picked) parts.push(`picked ${short(picked.detail.date)} at ${time(picked.detail.start)}`)
  else if (empty.size) parts.push(`looked at ${days.size} ${days.size === 1 ? 'day' : 'days'}, ${empty.size === days.size ? (days.size === 1 ? 'nothing free' : 'none had a free time') : `${empty.size} with nothing free`}`)
  else if (days.size) parts.push(`looked at ${days.size} ${days.size === 1 ? 'day' : 'days'}`)
  if (pref) parts.push(`would like ${PREFERENCE_LABELS[pref.detail.pref]?.toLowerCase()}`)
  if (!parts.length || (parts.length === 1 && minutes)) parts.push(stageOf(visit) === 0 ? 'opened the app and left' : 'chose a treatment and left')
  return parts.join(' · ')
}

// Each step of a visit in words, for the visit opened up.
export function stepLines(visit) {
  const words = {
    opened: () => 'Opened the booking page', area: () => 'Chose an area', treatment: () => 'Chose a treatment',
    length: (detail) => `Chose ${detail.people > 1 ? `${detail.people} people, ` : ''}${detail.minutes ? `${detail.minutes} min` : 'a length'}`,
    day: (detail) => `${short(detail.date)}: ${Number(detail.free) === 0 ? 'no free times' : `${detail.free} free ${Number(detail.free) === 1 ? 'time' : 'times'}`}`,
    wanted: (detail) => (detail.pref ? `None suited: would like ${PREFERENCE_LABELS[detail.pref]?.toLowerCase() || 'another time'}` : `Wanted ${short(detail.date)} at ${time(detail.start)} (not free)`),
    asked: (detail) => `Asked to hear if ${short(detail.date)} at ${time(detail.start)} frees up`,
    time: (detail) => `Picked ${short(detail.date)} at ${time(detail.start)}`,
    review: () => 'Checked the booking', details: () => 'Reached their details', payment: () => 'Reached payment',
    booked: (detail) => `Booked${detail.status === 'cancelled' ? ' (since cancelled)' : ''}`,
  }
  return visit.events.map((event) => ({ at: londonClock(event.at), text: (words[event.kind] || (() => event.kind))(event.detail || {}) }))
}

export const visitDay = (visit) => londonDay(visit.started_at)
export const visitClock = (visit) => londonClock(visit.started_at)
export const visitorName = (visit) => visit.client_name || (visit.client_id ? 'Client' : 'Visitor')
