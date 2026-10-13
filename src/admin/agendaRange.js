import { shiftDate } from './calendarPresentation.js'

// The range of days the Agenda shows when it is read again on a later day. Left open past midnight and never scrolled back to earlier
// days, it starts again from today and is as long as it was; in every other case it is left exactly as it is.
export function reanchored(range, anchor, day) {
  if (!range || !anchor || anchor === day || range.start !== anchor) return range
  const length = Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86400000)
  return { start: day, end: shiftDate(day, length) }
}
