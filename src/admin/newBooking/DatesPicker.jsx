import { useState } from 'react'
import { dateLabel, shiftDate } from '../calendarPresentation.js'
import { addMonths, MAX_DAYS_AHEAD, MAX_EXTRA_DATES, monthGrid, monthOf, monthTitle } from '../repeatPattern.js'

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const full = date => dateLabel(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const short = date => dateLabel(date, { weekday: 'short', day: 'numeric', month: 'short' })

// The dates a booking repeats on, chosen on a calendar: tap a day to add it, tap it again to take it away. Only days after the first appointment
// can be chosen (up to three years ahead), and each has the same time, length and address as the first.
export default function DatesPicker({ first, dates, onChange }) {
  const last = shiftDate(first, MAX_DAYS_AHEAD)
  const [month, setMonth] = useState(monthOf(dates[0] || shiftDate(first, 1)))
  const { lead, days } = monthGrid(month)
  const atLimit = dates.length >= MAX_EXTRA_DATES
  const toggle = date => onChange(dates.includes(date) ? dates.filter(item => item !== date) : [...dates, date].sort())
  return <div className="anb-dates">
    <div className="anb-dates-head">
      <button type="button" className="anb-dates-nav" aria-label="Previous month" disabled={month <= monthOf(first)} onClick={() => setMonth(addMonths(month, -1))}><span aria-hidden="true">‹</span></button>
      <strong id="anb-dates-month" aria-live="polite">{monthTitle(month)}</strong>
      <button type="button" className="anb-dates-nav" aria-label="Next month" disabled={month >= monthOf(last)} onClick={() => setMonth(addMonths(month, 1))}><span aria-hidden="true">›</span></button>
    </div>
    <div className="anb-dates-grid" role="group" aria-labelledby="anb-dates-month">
      {WEEK.map(name => <span key={name} className="anb-dates-dow" aria-hidden="true">{name}</span>)}
      {Array.from({ length: lead }, (_, index) => <span key={`gap-${index}`} aria-hidden="true" />)}
      {days.map(date => {
        const chosen = dates.includes(date)
        return <button key={date} type="button" className={`anb-date${date === first ? ' anb-date--first' : ''}`} aria-pressed={chosen}
          aria-label={full(date) + (date === first ? ' (the first appointment)' : '')} disabled={date <= first || date > last || (atLimit && !chosen)} onClick={() => toggle(date)}>{Number(date.slice(8))}</button>
      })}
    </div>
    {dates.length > 0
      ? <ul className="anb-date-list" aria-label="Chosen dates">{dates.map(date => <li key={date}><button type="button" aria-label={`Remove ${full(date)}`} onClick={() => toggle(date)}>{short(date)} <span aria-hidden="true">×</span></button></li>)}</ul>
      : <p className="anb-hint">Tap the days it repeats on. Each one has the same time, length and address as the first appointment.</p>}
    {atLimit && <p className="anb-hint">That is the most a repeat can have. Take one off to add another.</p>}
  </div>
}
