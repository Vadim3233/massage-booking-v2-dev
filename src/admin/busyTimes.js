// Busiest times (ADR-101): the rankings on the Income page and the "When … books" card on a client's page.
// The database only lists the visits (admin_busy_times in 20261213100000_busy_times.sql); this file does the counting and the plain words,
// so it can be tested without a database.
//
// A visit is a booking that was completed, or a confirmed booking whose day has passed, the same rule as the client stats (ADR-099).
// Its money is what was received for it, after any refund.

export const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
// Parts of the day, by the time the appointment starts.
export const PARTS = [
  { key: 'morning', name: 'Morning', hours: 'Before 12:00', plural: 'mornings', phrase: 'in the morning' },
  { key: 'afternoon', name: 'Afternoon', hours: '12:00 to 17:00', plural: 'afternoons', phrase: 'in the afternoon' },
  { key: 'evening', name: 'Evening', hours: 'From 17:00', plural: 'evenings', phrase: 'in the evening' },
]
export const partOf = minutes => minutes < 720 ? 0 : minutes < 1020 ? 1 : 2
// Below these, a ranking would mislead, so the page says it is early days.
export const ENOUGH_DAYS = 28
export const ENOUGH_CLIENT_VISITS = 3

const DAY_MS = 86400000
const parse = iso => new Date(`${iso}T00:00:00Z`)
const iso = date => date.toISOString().slice(0, 10)
export const addDays = (day, count) => iso(new Date(parse(day).getTime() + count * DAY_MS))
export const weekday = day => (parse(day).getUTCDay() + 6) % 7
export const daysBetween = (from, to) => Math.round((parse(to) - parse(from)) / DAY_MS)
export const shortDay = day => parse(day).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
export const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
const pounds = value => `£${Math.round(Number(value) || 0).toLocaleString('en-GB')}`
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

// The next date after `from` (never `from` itself) that falls on a weekday (0 = Monday).
export function nextWeekday(from, day) {
  const ahead = (day - weekday(from) + 7) % 7 || 7
  return addDays(from, ahead)
}

// ---------------------------------------------------------------------------------------------
// Bank holidays in England and Wales, worked out from the rules, so they never need typing in. One-off extra days (a royal wedding or
// coronation) are not known in advance and are not included.
// ---------------------------------------------------------------------------------------------
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1
  return iso(new Date(Date.UTC(year, month - 1, day)))
}
const firstMonday = (year, month) => nextWeekday(iso(new Date(Date.UTC(year, month - 1, 0))), 0)
const lastMonday = (year, month) => { const end = iso(new Date(Date.UTC(year, month, 0))); return addDays(end, -weekday(end)) }

export function bankHolidays(year) {
  const easter = easterSunday(year)
  let newYear = `${year}-01-01`
  if (weekday(newYear) >= 5) newYear = nextWeekday(newYear, 0)
  // Christmas and Boxing Day: a day that falls at the weekend moves to the next free weekday.
  const christmas = `${year}-12-25`, boxing = `${year}-12-26`
  const taken = new Set()
  const shift = day => { let date = day; while (weekday(date) >= 5 || taken.has(date)) date = addDays(date, 1); taken.add(date); return date }
  const christmasDay = weekday(christmas) >= 5 ? null : shift(christmas)
  const boxingDay = weekday(boxing) >= 5 ? null : shift(boxing)
  const christmasMoved = christmasDay ?? shift(christmas)
  const boxingMoved = boxingDay ?? shift(boxing)
  return [
    { date: newYear, name: 'New Year’s Day' },
    { date: addDays(easter, -2), name: 'Good Friday' },
    { date: addDays(easter, 1), name: 'Easter Monday' },
    { date: firstMonday(year, 5), name: 'Early May bank holiday' },
    { date: lastMonday(year, 5), name: 'Spring bank holiday' },
    { date: lastMonday(year, 8), name: 'Summer bank holiday' },
    { date: christmasMoved, name: christmasDay ? 'Christmas Day' : 'Christmas Day (substitute day)' },
    { date: boxingMoved, name: boxingDay ? 'Boxing Day' : 'Boxing Day (substitute day)' },
  ].sort((x, y) => x.date.localeCompare(y.date))
}
export function bankHolidaysBetween(from, to) {
  const list = []
  for (let year = parse(from).getUTCFullYear(); year <= parse(to).getUTCFullYear(); year += 1) list.push(...bankHolidays(year))
  return list.filter(item => item.date >= from && item.date <= to)
}

// ---------------------------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------------------------
function tally(visits, keyOf, size) {
  const rows = Array.from({ length: size }, (_, index) => ({ index, bookings: 0, gbp: 0 }))
  for (const visit of visits) { const row = rows[keyOf(visit)]; row.bookings += 1; row.gbp += Number(visit.net_gbp) || 0 }
  return rows
}
// Best first. Rows with no bookings at all go to the end and are never called the quietest: they are usually days off.
export function ranked(rows, by = 'bookings') {
  const value = row => by === 'gbp' ? row.gbp : by === 'full' ? (row.full ?? -1) : row.bookings
  // By How full, a weekday with no working hours set has nothing to rank and is left out.
  const busy = rows.filter(row => row.bookings > 0 && (by !== 'full' || (row.full !== null && row.full !== undefined))).sort((a, b) => value(b) - value(a) || b.bookings - a.bookings || a.index - b.index)
  return {
    busy: busy.map((row, position) => ({ ...row, best: position === 0 && busy.length > 1, quietest: busy.length > 2 && position === busy.length - 1 })),
    empty: rows.filter(row => row.bookings === 0),
    top: busy.length ? value(busy[0]) : 0,
  }
}

// Each past bank holiday, against a normal day of the same weekday in the same stretch of time.
function holidayComparison(visits, from, yesterday) {
  const holidays = bankHolidaysBetween(from, yesterday)
  const holidayDates = new Set(holidays.map(item => item.date))
  const perDate = new Map()
  for (const visit of visits) {
    const row = perDate.get(visit.date) || { bookings: 0, gbp: 0 }
    row.bookings += 1; row.gbp += Number(visit.net_gbp) || 0
    perDate.set(visit.date, row)
  }
  // Ordinary days of each weekday (not bank holidays), and what they brought.
  const normal = Array.from({ length: 7 }, () => ({ days: 0, bookings: 0, gbp: 0 }))
  for (let day = from; day <= yesterday; day = addDays(day, 1)) {
    if (holidayDates.has(day)) continue
    const slot = normal[weekday(day)], row = perDate.get(day)
    slot.days += 1
    if (row) { slot.bookings += row.bookings; slot.gbp += row.gbp }
  }
  const past = holidays.map(holiday => {
    const row = perDate.get(holiday.date) || { bookings: 0, gbp: 0 }
    const slot = normal[weekday(holiday.date)]
    const usual = slot.days ? slot.bookings / slot.days : 0
    const usualGbp = slot.days ? slot.gbp / slot.days : 0
    return { ...holiday, ...row, usual, usualGbp, verdict: verdict(row.bookings, usual) }
  }).reverse()
  const actual = past.reduce((sum, item) => sum + item.bookings, 0)
  const expected = past.reduce((sum, item) => sum + item.usual, 0)
  return { past, overall: past.length ? verdict(actual, expected) : null }
}
function verdict(actual, usual) {
  if (actual === 0 && usual < 0.5) return 'same'
  if (usual === 0) return 'busier'
  const ratio = actual / usual
  return ratio >= 1.3 ? 'busier' : ratio <= 0.7 ? 'quieter' : 'same'
}

// Everything the Income page's "Busiest times" section shows. `data` is what admin_busy_times returns: { today, visits: [{ date, start_minutes, net_gbp }] }.
export function busySummary(data) {
  const visits = (data?.visits || []).filter(visit => visit.date < data.today)
  if (!visits.length) return { count: 0 }
  const since = visits.reduce((min, visit) => visit.date < min ? visit.date : min, visits[0].date)
  const yesterday = addDays(data.today, -1)
  const span = daysBetween(since, data.today)
  const hourCounts = new Map()
  for (const visit of visits) { const hour = Math.floor(visit.start_minutes / 60); hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1) }
  const [topHour] = [...hourCounts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]
  const months = tally(visits, visit => parse(visit.date).getUTCMonth(), 12)
  const thisMonth = parse(data.today).getUTCMonth()
  const upcoming = bankHolidaysBetween(data.today, addDays(data.today, 45))[0] || null
  const fill = fullness(data.days, data.today)
  return {
    count: visits.length,
    since,
    span,
    enough: span >= ENOUGH_DAYS,
    fullYear: span >= 365,
    days: tally(visits, visit => weekday(visit.date), 7).map((row, index) => ({ ...row, full: fill.weekdays[index] })),
    parts: tally(visits, visit => partOf(visit.start_minutes), 3),
    grid: grid(visits),
    fullLast4: fill.last4,
    hasFull: fill.weekdays.some(value => value !== null),
    calendar: data.days || [],
    regulars: data.regulars || [],
    topHour,
    months: months.map(row => ({ ...row, soFar: row.index === thisMonth && row.bookings > 0 })),
    monthsWithData: months.filter(row => row.bookings > 0).length,
    holidays: holidayComparison(visits, since, yesterday),
    upcoming: upcoming && { ...upcoming, inDays: daysBetween(data.today, upcoming.date) },
    wanted: wantedSummary(data.wanted),
    today: data.today,
  }
}

// How full: booked minutes out of working minutes (the database counts both, in half hours, from the hours set for each day). Per weekday over
// all past days, and for the last 4 weeks. A weekday with no working time at all gives null, never 0%.
export function fullness(days, today) {
  const per = Array.from({ length: 7 }, () => ({ open: 0, booked: 0 }))
  let open = 0, booked = 0
  const from = addDays(today, -28)
  for (const day of days || []) {
    if (day.date >= today || !day.open) continue
    const slot = per[weekday(day.date)]
    slot.open += day.open; slot.booked += Math.min(day.booked, day.open)
    if (day.date >= from) { open += day.open; booked += Math.min(day.booked, day.open) }
  }
  const pct = (part, whole) => whole ? Math.round(100 * part / whole) : null
  return { weekdays: per.map(slot => pct(slot.booked, slot.open)), last4: pct(booked, open) }
}
// Visits by weekday (columns) and part of the day (rows), for the week grid.
export function grid(visits) {
  const cells = Array.from({ length: 3 }, () => Array(7).fill(0))
  for (const visit of visits) cells[partOf(visit.start_minutes)][weekday(visit.date)] += 1
  return cells
}

// Wanted times (from the Visitors log, last 90 days): times people tapped on the booking page although they were taken. Demand that got away.
export function wantedSummary(wanted) {
  const list = wanted || []
  const days = Array(7).fill(0), parts = Array(3).fill(0), pairs = new Map(), cells = Array.from({ length: 3 }, () => Array(7).fill(0))
  for (const item of list) {
    const day = weekday(item.date), part = partOf(item.start_minutes)
    days[day] += 1; parts[part] += 1; cells[part][day] += 1
    const key = `${day}:${part}`
    pairs.set(key, (pairs.get(key) || 0) + 1)
  }
  const top = [...pairs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  return { count: list.length, days, parts, cells, top: top ? { day: Number(top[0][0]), part: Number(top[0][2]), count: top[1] } : null }
}
// The "more hours?" idea: the day and part of the day people most often wanted when it was full, at least twice.
export function wantedTip(summary) {
  const top = summary?.wanted?.top
  if (!top || top.count < 2) return null
  return { day: DAYS[top.day], part: PARTS[top.part], count: top.count, date: nextWeekday(summary.today, top.day) }
}

// The quiet-day idea: the quietest weekday that does get bookings (by How full when the hours are known, otherwise by bookings), its next
// date in the coming two weeks with at least an hour free, and the regulars who usually come on that weekday and are due.
export function quietDayTip(summary) {
  if (!summary?.enough || summary.count < 10) return null
  // Only days that get bookings and, when the hours are known, have working time.
  const candidates = summary.days.filter(row => row.bookings > 0 && (!summary.hasFull || row.full !== null))
  if (candidates.length < 2) return null
  const value = row => summary.hasFull ? row.full : row.bookings
  const quiet = candidates.reduce((low, row) => value(row) < value(low) ? row : low)
  const ahead = summary.calendar.filter(day => day.date > summary.today && weekday(day.date) === quiet.index)
  const next = ahead.find(day => day.open - Math.min(day.booked, day.open) >= 60)
  if (summary.calendar.length && !next) return null
  return {
    day: DAYS[quiet.index],
    date: next ? next.date : nextWeekday(summary.today, quiet.index),
    freeMinutes: next ? next.open - Math.min(next.booked, next.open) : null,
    regulars: dueRegulars(summary.regulars, quiet.index, summary.today),
  }
}
// Regulars (3 or more visits, nothing booked) whose most usual weekday is this one and who are due within a week, most overdue first.
export function dueRegulars(regulars, day, today, limit = 3) {
  return (regulars || []).filter(row => {
    const counts = row.weekdays || []
    const most = Math.max(0, ...counts)
    if (!most || counts[day] !== most || counts.filter(value => value === most).length > 1) return false
    if (row.gap_days == null || !row.last_visit) return false
    return daysBetween(row.last_visit, today) >= row.gap_days - 7
  }).map(row => ({ ...row, since: daysBetween(row.last_visit, today), overdue: daysBetween(row.last_visit, today) - row.gap_days }))
    .sort((a, b) => b.overdue - a.overdue).slice(0, limit)
}
export const freeWords = minutes => minutes >= 60 ? `${Math.floor(minutes / 60)}${minutes % 60 ? '½' : ''} free ${minutes >= 120 ? 'hours' : 'hour'}` : `${minutes} free minutes`

// The Monday "Your week" message: the same ideas as the page, in a few lines. Null when there is nothing worth sending.
export function weeklyText(data) {
  const summary = busySummary(data)
  if (!summary.count) return null
  const lines = ['Your week']
  if (summary.fullLast4 !== null && summary.fullLast4 !== undefined) lines.push(`Last 4 weeks: ${summary.fullLast4}% of your working hours were booked.`)
  const tip = quietDayTip(summary)
  if (tip) {
    lines.push(`Quietest day: ${shortDay(tip.date)}${tip.freeMinutes ? `, ${freeWords(tip.freeMinutes)}` : ''}. A special price offer could fill it.`)
    if (tip.regulars.length) lines.push(`${listWords(tip.regulars.map(row => row.first_name || 'A client'))} usually ${tip.regulars.length === 1 ? 'books' : 'book'} on ${tip.day}s and ${tip.regulars.length === 1 ? 'is' : 'are'} due.`)
  }
  const want = wantedTip(summary)
  if (want) lines.push(`${plural(want.count, 'person')} wanted a ${want.day} ${want.part.name.toLowerCase()} when you were full (last 90 days).`.replace('persons', 'people'))
  if (summary.upcoming && summary.upcoming.inDays <= 14) lines.push(`${summary.upcoming.name}: ${shortDay(summary.upcoming.date)}. Are you working?`)
  if (lines.length === 1) return null
  lines.push('More in Income › Busiest times.')
  return lines.join('\n')
}
const listWords = names => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

// One sentence on top of each ranking.
export function headline(view, summary, by) {
  if (view === 'days') {
    const { busy } = ranked(summary.days, by)
    if (busy.length < 2) return `All your bookings so far were on a ${DAYS[busy[0].index]}.`
    const quiet = busy.find(row => row.quietest)
    const word = by === 'full' ? 'fullest' : 'best'
    return `${DAYS[busy[0].index]} is your ${word} day${quiet ? `, ${DAYS[quiet.index]} your quietest` : ''}.`
  }
  if (view === 'times') {
    const { busy } = ranked(summary.parts, by)
    return `Most ${by === 'gbp' ? 'income comes' : 'bookings start'} in the ${PARTS[busy[0].index].name.toLowerCase()}. The most popular start is ${clock(summary.topHour * 60)}.`
  }
  if (view === 'months') {
    const { busy } = ranked(summary.months, by)
    return `${MONTHS[busy[0].index]} is your best month${summary.fullYear ? '' : ' so far'}.`
  }
  const overall = summary.holidays.overall
  if (!overall) return 'No bank holidays since your first booking yet.'
  return overall === 'busier' ? 'Bank holidays have been busier than a normal day.'
    : overall === 'quieter' ? 'Bank holidays have been quieter than a normal day.' : 'Bank holidays have been about as busy as a normal day.'
}
export const rowMeta = row => `${plural(row.bookings, 'booking')} · ${pounds(row.gbp)}`
export const wantedWords = count => count ? `${count} wanted when full` : ''
export const usualWords = value => value === 0 ? 'no bookings' : value < 0.95 ? `about ${value.toFixed(1)} bookings` : `about ${plural(Math.round(value), 'booking')}`
export const verdictWords = (item) => {
  const day = DAYS[weekday(item.date)]
  if (item.verdict === 'busier') return item.usual > 0 && item.bookings / item.usual >= 2 ? `About ${Math.round(item.bookings / item.usual)} times busier than a normal ${day}` : `Busier than a normal ${day}`
  if (item.verdict === 'quieter') return `Quieter than a normal ${day}`
  return `About the same as a normal ${day}`
}
export { pounds, plural }

// ---------------------------------------------------------------------------------------------
// One client: when they usually book
// ---------------------------------------------------------------------------------------------
const share = (count, total) => total ? count / total : 0
export function clientTimes(visits, today) {
  const past = (visits || []).filter(visit => visit.date < today)
  const count = past.length
  if (!count) return { count: 0 }
  const days = tally(past, visit => weekday(visit.date), 7).map(row => row.bookings)
  const parts = tally(past, visit => partOf(visit.start_minutes), 3).map(row => row.bookings)
  const order = days.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value || a.index - b.index)
  const partOrder = parts.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value || a.index - b.index)
  const hours = new Map()
  for (const visit of past) { const hour = Math.floor(visit.start_minutes / 60); hours.set(hour, (hours.get(hour) || 0) + 1) }
  const [hour, hourCount] = [...hours.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]
  const result = { count, days, parts }
  if (count < ENOUGH_CLIENT_VISITS) {
    const first = past[0]
    const part = PARTS[partOf(first.start_minutes)]
    if (count === 1) result.sentence = `The only visit so far was on a ${DAYS[weekday(first.date)]} ${part.name.toLowerCase()}.`
    else {
      const second = past[1]
      const sameDay = weekday(first.date) === weekday(second.date), samePart = partOf(first.start_minutes) === partOf(second.start_minutes)
      result.sentence = sameDay ? `Both visits so far were on a ${DAYS[weekday(first.date)]}${samePart ? ` ${part.name.toLowerCase()}` : ''}.`
        : `The two visits so far were on a ${DAYS[weekday(first.date)]} and a ${DAYS[weekday(second.date)]}.`
    }
    return result
  }
  const single = share(order[0].value, count) > 0.5 ? order[0].index : null
  const pair = single === null && share(order[0].value + order[1].value, count) >= 0.7 ? [order[0].index, order[1].index].sort((a, b) => a - b) : null
  const part = share(partOrder[0].value, count) >= 0.6 ? PARTS[partOrder[0].index] : null
  let sentence
  if (single !== null && part) sentence = `Usually ${DAYS[single]} ${part.plural}`
  else if (single !== null) sentence = `Usually ${DAYS[single]}s`
  else if (pair && part) sentence = `Usually ${DAYS[pair[0]]}s or ${DAYS[pair[1]]}s, ${part.phrase}`
  else if (pair) sentence = `Usually ${DAYS[pair[0]]}s or ${DAYS[pair[1]]}s`
  else if (part) sentence = `No set day, usually ${part.phrase}`
  else sentence = 'No set day or time'
  if (share(hourCount, count) >= 0.4) sentence += `, around ${clock(hour * 60)}`
  result.sentence = `${sentence}.`
  result.usualDay = single
  // The months they come most, once there is close to a year of visits to go on.
  const first = past.reduce((min, visit) => visit.date < min ? visit.date : min, past[0].date)
  if (daysBetween(first, today) >= 300 && count >= 6) {
    const months = tally(past, visit => parse(visit.date).getUTCMonth(), 12).map(row => row.bookings)
    const most = Math.max(...months)
    if (most >= 2) {
      const names = months.map((value, index) => value === most ? MONTHS[index] : null).filter(Boolean)
      if (names.length <= 3) result.months = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
    }
  }
  return result
}

// The times one client tried to book when they were full (Visitors, last 90 days), in words: "Sat 10:00 twice", or "Sat 10:00 and Fri 18:00".
export function clientWanted(wanted) {
  const counts = new Map()
  for (const item of wanted || []) {
    const key = `${weekday(item.date)}:${item.start_minutes}`
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2)
  if (!top.length) return null
  const words = ([key, count]) => {
    const [day, minutes] = key.split(':').map(Number)
    return `${DAYS[day].slice(0, 3)} ${clock(minutes)}${count === 2 ? ' twice' : count > 2 ? ` ${count} times` : ''}`
  }
  return top.map(words).join(' and ')
}
