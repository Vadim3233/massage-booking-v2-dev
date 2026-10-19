import { dateLabel, shiftDate, time } from './calendarPresentation.js'

// How a booking can repeat, in words and in what the database is told. A repeat is every week (as it always was), every 2, 3 or 4 weeks, once a month
// on the same weekday as the first booking (the first Thursday, say), or on dates chosen one by one. Nothing here talks to the database.

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
export const dayName = date => DAY_NAMES[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7]

// Dates chosen one by one come after the first booking, up to 59 of them and three years ahead (the same limits the database keeps).
export const MAX_EXTRA_DATES = 59
export const MAX_DAYS_AHEAD = 1100

export const emptyRepeat = { on: false, kind: 'weeks', every: 1, dates: [], endDate: '' }

const ORDINALS = ['first', 'second', 'third', 'fourth', 'last']
// Which such weekday of its month a date is: 1 to 4, and 5 for a fifth, which is always the last one of that month.
export const monthWeek = date => Math.min(Math.floor((Number(date.slice(8, 10)) - 1) / 7) + 1, 5)
export const monthlyWords = (weekdayName, week) => `the ${ORDINALS[week - 1]} ${weekdayName}`

const long = date => dateLabel(date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
const short = date => dateLabel(date, { weekday: 'short', day: 'numeric', month: 'short' })

// The ways to repeat, for the first booking's day: a short name to tap and a full sentence for when it is chosen.
export function repeatChoices(date) {
  const day = dayName(date)
  return [
    { value: 'weeks:1', short: 'Every week', long: `Every ${day}` },
    { value: 'weeks:2', short: 'Every 2 weeks', long: `Every 2 weeks, on ${day}` },
    { value: 'weeks:3', short: 'Every 3 weeks', long: `Every 3 weeks, on ${day}` },
    { value: 'weeks:4', short: 'Every 4 weeks', long: `Every 4 weeks, on ${day}` },
    { value: 'monthly', short: 'Every month', long: `Every month, on ${monthlyWords(day, monthWeek(date))}` },
    { value: 'dates', short: 'Dates I choose', long: 'On the dates you choose, one by one' },
  ]
}
export const choiceValue = repeat => repeat.kind === 'weeks' ? `weeks:${repeat.every}` : repeat.kind
export function choiceChange(value) {
  if (value === 'monthly' || value === 'dates') return { kind: value, every: 1 }
  return { kind: 'weeks', every: Number(value.split(':')[1]) }
}

// The dates that count: after the first booking, within three years, once each, in order.
export const chosenDates = (repeat, firstDate) => [...new Set(repeat.dates || [])].filter(date => date > firstDate && date <= shiftDate(firstDate, MAX_DAYS_AHEAD)).sort()

// Moving the first booking later drops any chosen date that is no longer after it; a time outside the usual ones is never a repeat.
export const repeatFor = (repeat, firstDate, off = false) => ({ ...repeat, ...(off ? { on: false } : {}), dates: chosenDates(repeat, firstDate) })

// What is still missing before the repeat can be made, in words (nothing when it is complete).
export function repeatProblem(repeat, firstDate) {
  if (repeat.kind === 'dates' && !chosenDates(repeat, firstDate).length) return 'Choose the dates it repeats on, or change how often it repeats.'
  return ''
}

// What the database is told: the end date, and the pattern (nothing for a plain weekly repeat, which is what it always was).
export function repeatRequest(repeat, firstDate) {
  if (repeat.kind === 'dates') return { endDate: null, pattern: { kind: 'dates', dates: chosenDates(repeat, firstDate) } }
  const endDate = repeat.endDate || null
  if (repeat.kind === 'monthly') return { endDate, pattern: { kind: 'monthly' } }
  return { endDate, pattern: repeat.every > 1 ? { kind: 'weeks', every_weeks: repeat.every } : null }
}

// The repeat being set up, as a sentence for the summary.
export function describeDraftRepeat(repeat, firstDate) {
  const day = dayName(firstDate)
  if (repeat.kind === 'dates') {
    const dates = chosenDates(repeat, firstDate)
    if (!dates.length) return 'Repeats on dates you choose.'
    const shown = dates.slice(0, 8).map(short).join(', ') + (dates.length > 8 ? ` and ${dates.length - 8} more` : '')
    return `Repeats on ${dates.length === 1 ? 'one more date' : `${dates.length} more dates`}: ${shown}.`
  }
  const rule = repeat.kind === 'monthly' ? `on ${monthlyWords(day, monthWeek(firstDate))} of every month` : repeat.every > 1 ? `every ${repeat.every} weeks, on ${day}` : `every ${day}`
  return `Repeats ${rule}${repeat.endDate ? ` until ${long(repeat.endDate)}` : ', with no end date'}.`
}

// A repeat that has been made (as the client's page lists it).
export function describeRepeat(series) {
  const day = DAY_NAMES[series.weekday - 1]
  const at = `at ${time(series.start_minutes)} · ${series.treatment_duration_minutes} min`
  if (series.pattern === 'monthly') return `Every month, on ${monthlyWords(day, series.month_week)} ${at}`
  if (series.pattern === 'dates') return `On chosen dates ${at}`
  return series.every_weeks > 1 ? `Every ${series.every_weeks} weeks, on ${day} ${at}` : `Every ${day} ${at}`
}

// The calendar for choosing dates: a month is '2026-11'; a grid starts on a Monday.
export const monthOf = date => date.slice(0, 7)
export function addMonths(month, count) {
  const [year, index] = month.split('-').map(Number)
  return new Date(Date.UTC(year, index - 1 + count, 1)).toISOString().slice(0, 7)
}
export function monthGrid(month) {
  const [year, index] = month.split('-').map(Number)
  const lead = (new Date(Date.UTC(year, index - 1, 1)).getUTCDay() + 6) % 7
  const count = new Date(Date.UTC(year, index, 0)).getUTCDate()
  return { lead, days: Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`) }
}
export const monthTitle = month => new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T12:00:00Z`))
