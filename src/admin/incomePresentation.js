import { dateLabel, money, shiftDate, time } from './calendarPresentation.js'

// Words for the Income screen. Every amount and every period comes from the database (admin_income_summary and friends); this only puts them
// into words, moves the arrows to the day before or after a period, and lays out the accountant's file.

const MONTH = { month: 'long', year: 'numeric' }
const sameYear = (a, b) => a.slice(0, 4) === b.slice(0, 4)

// "19 – 25 Oct 2026", "October 2026", "2026", "Tax year 2026/27".
export function periodLabel(summary) {
  const { kind, from, to } = summary
  if (kind === 'month') return dateLabel(from, MONTH)
  if (kind === 'year') return from.slice(0, 4)
  if (kind === 'tax_year') return `Tax year ${from.slice(0, 4)}/${to.slice(2, 4)}`
  const start = dateLabel(from, sameYear(from, to) ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
  return `${start} – ${dateLabel(to, { day: 'numeric', month: 'short', year: 'numeric' })}`
}

// The arrows: any day in the period before or after this one.
export const previousAnchor = summary => shiftDate(summary.from, -1)
export const nextAnchor = summary => shiftDate(summary.to, 1)

const PREVIOUS_WORDS = { week: 'last week', month: 'last month', year: 'last year', tax_year: 'last tax year' }
// "+12% vs last month", "-5% vs last week", or "—" when the period before brought nothing.
export function comparisonText(summary) {
  const change = summary.change_percent
  if (change === null || change === undefined) return '—'
  return `${Number(change) > 0 ? '+' : ''}${Number(change)}% vs ${PREVIOUS_WORDS[summary.kind]}`
}

const STILL_WORDS = { week: 'this week', month: 'this month', year: 'this year', tax_year: 'this tax year' }
// "£520.00 still to come this month", only for a period not yet over and only when there is something.
export function stillToComeText(summary) {
  const amount = Number(summary.still_to_come_gbp)
  return summary.still_to_come_gbp === null || summary.still_to_come_gbp === undefined || !(amount > 0) ? '' : `${money(amount)} still to come ${STILL_WORDS[summary.kind]}`
}

// Each bar's short name: Mon (a week's days), 19 Oct (a month's weeks, by their first day), Jan (a year's months).
export function barLabel(kind, bar) {
  if (kind === 'week') return dateLabel(bar.from, { weekday: 'short' })
  if (kind === 'month') return dateLabel(bar.from, { day: 'numeric', month: 'short' })
  return dateLabel(bar.from, { month: 'short' })
}
// The words a screen reader gives for a bar: "Mon 19 Oct: £180.00", "19 – 25 Oct: £520.00", "January: £1,800.00".
export function barDescription(kind, bar) {
  const amount = money(Number(bar.total_gbp))
  if (kind === 'week') return `${dateLabel(bar.from)}: ${amount}`
  if (kind === 'month') return `${dateLabel(bar.from, { day: 'numeric', month: 'short' })} – ${dateLabel(bar.to, { day: 'numeric', month: 'short' })}: ${amount}`
  return `${dateLabel(bar.from, { month: 'long' })}: ${amount}`
}

const METHOD = { bank_transfer: 'Bank transfer', cash: 'Cash' }
export const methodName = method => METHOD[method] || 'Other'
// One line of the list: "Mon 19 Oct, 10:00", the client, the amount and how it was paid ("refund £70.00 sent" or "late fee" when so).
export function rowWhen(row) { return `${dateLabel(row.date)}, ${time(row.start_minutes)}` }
export function rowNote(row) {
  const notes = [methodName(row.method)]
  if (Number(row.refund_gbp) > 0) notes.push(`refund ${money(Number(row.refund_gbp))} sent`)
  if (Number(row.late_fee_gbp) > 0) notes.push('late fee')
  return notes.join(' · ')
}

// The accountant's file: one row per booking, plain numbers with two decimals, dates as YYYY-MM-DD.
const cell = value => {
  const text = String(value ?? '')
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
const amount = value => Number(value ?? 0).toFixed(2)
export function incomeCsv(rows) {
  const lines = [['Date', 'Booking reference', 'Client', 'Method', 'Amount received', 'Refund', 'Net']]
  for (const row of rows) lines.push([row.date, row.booking_reference, row.client_name || '', methodName(row.method), amount(row.received_gbp), amount(row.refund_gbp), amount(row.net_gbp)])
  return lines.map(line => line.map(cell).join(',')).join('\r\n') + '\r\n'
}
export function csvFileName(summary) {
  const name = { week: `week-${summary.from}`, month: summary.from.slice(0, 7), year: summary.from.slice(0, 4), tax_year: `tax-year-${summary.from.slice(0, 4)}-${summary.to.slice(2, 4)}` }[summary.kind]
  return `vadmassage-income-${name}.csv`
}
