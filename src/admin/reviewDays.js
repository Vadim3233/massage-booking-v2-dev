import { dayHeading, today } from './calendarPresentation.js'

// The payments to check under the day of their appointment, the soonest day first, so the question "has Wednesday's paid?" is answered
// by the heading she is looking at. Within a day, the ones that need the Admin come first.
export function groupByAppointmentDay(bookings, needsYou, from = today()) {
  const sorted = [...bookings].sort((a, b) => a.date.localeCompare(b.date) || a.start_minutes - b.start_minutes)
  const days = []
  for (const booking of sorted) {
    let day = days.at(-1)
    if (day?.date !== booking.date) { day = { date: booking.date, ...dayHeading(booking.date, from), items: [] }; days.push(day) }
    day.items.push(booking)
  }
  return days.map(day => {
    const needs = day.items.filter(needsYou)
    return { ...day, items: [...needs, ...day.items.filter(booking => !needsYou(booking))], needs: needs.length, owed: needs.reduce((sum, booking) => sum + Number(booking.total_gbp), 0) }
  })
}
