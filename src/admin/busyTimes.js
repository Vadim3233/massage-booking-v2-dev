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
  const value = row => by === 'gbp' ? row.gbp : row.bookings
  const busy = rows.filter(row => row.bookings > 0).sort((a, b) => value(b) - value(a) || b.bookings - a.bookings || a.index - b.index)
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
  return {
    count: visits.length,
    since,
    span,
    enough: span >= ENOUGH_DAYS,
    fullYear: span >= 365,
    days: tally(visits, visit => weekday(visit.date), 7),
    parts: tally(visits, visit => partOf(visit.start_minutes), 3),
    topHour,
    months: months.map(row => ({ ...row, soFar: row.index === thisMonth && row.bookings > 0 })),
    monthsWithData: months.filter(row => row.bookings > 0).length,
    holidays: holidayComparison(visits, since, yesterday),
    upcoming: upcoming && { ...upcoming, inDays: daysBetween(data.today, upcoming.date) },
    wanted: wantedSummary(data.wanted),
    today: data.today,
  }
}

// Wanted times (from the Visitors log, last 90 days): times people tapped on the booking page although they were taken. Demand that got away.
export function wantedSummary(wanted) {
  const list = wanted || []
  const days = Array(7).fill(0), parts = Array(3).fill(0), pairs = new Map()
  for (const item of list) {
    const day = weekday(item.date), part = partOf(item.start_minutes)
    days[day] += 1; parts[part] += 1
    const key = `${day}:${part}`
    pairs.set(key, (pairs.get(key) || 0) + 1)
  }
  const top = [...pairs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  return { count: list.length, days, parts, top: top ? { day: Number(top[0][0]), part: Number(top[0][2]), count: top[1] } : null }
}
// The "more hours?" idea: the day and part of the day people most often wanted when it was full, at least twice.
export function wantedTip(summary) {
  const top = summary?.wanted?.top
  if (!top || top.count < 2) return null
  return { day: DAYS[top.day], part: PARTS[top.part], count: top.count, date: nextWeekday(summary.today, top.day) }
}

// The quiet-day idea: the quietest day that does get bookings, and the next one coming, to open and offer a special price for a free gap.
export function quietDayTip(summary) {
  if (!summary?.enough || summary.count < 10) return null
  const { busy } = ranked(summary.days, 'bookings')
  const quiet = busy.find(row => row.quietest)
  if (!quiet) return null
  return { day: DAYS[quiet.index], date: nextWeekday(summary.today, quiet.index) }
}

// One sentence on top of each ranking.
export function headline(view, summary, by) {
  if (view === 'days') {
    const { busy } = ranked(summary.days, by)
    if (busy.length < 2) return `All your bookings so far were on a ${DAYS[busy[0].index]}.`
    const quiet = busy.find(row => row.quietest)
    return `${DAYS[busy[0].index]} is your best day${quiet ? `, ${DAYS[quiet.index]} your quietest` : ''}.`
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
