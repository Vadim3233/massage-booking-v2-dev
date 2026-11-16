import { dateLabel, shiftDate, today } from './calendarPresentation.js'

// What the Admin is waiting for on one item: the extra still owed on a paid booking, or the booking's own price.
export const reviewAmount = (booking, isExtra) => Number(isExtra(booking) ? booking.balance_due_gbp : booking.total_gbp) || 0

const byWhen = (a, b) => a.date.localeCompare(b.date) || a.start_minutes - b.start_minutes || String(a.id).localeCompare(String(b.id))

// The payments to check, one group per client, so a client who owes for three sessions is one short card instead of three long ones.
// Only the same client account is grouped: a booking with no client is a group of its own, and two clients with the same name never merge.
//   needsYou(booking): the Admin has something to do on it now (it is not put off with "Not yet").
//   putOff(booking):   it is put off with "Not yet" until a time the Admin chose.
//   isExtra(booking):  it is paid, with an extra still owed (extra time, or a change that cost more).
// Each group goes in one section: 'needs' when anything in it needs the Admin, else 'reminded' when something is put off, else 'waiting'
// (a new booking whose client has not paid yet). Within a section, the client who has waited longest comes first.
export function groupByClient(bookings, { needsYou, putOff = () => false, isExtra = () => false }) {
  const groups = new Map()
  for (const booking of [...bookings].sort(byWhen)) {
    const key = booking.client_id ? `client:${booking.client_id}` : `booking:${booking.id}`
    if (!groups.has(key)) groups.set(key, { key, clientId: booking.client_id || null, items: [] })
    groups.get(key).items.push(booking)
  }
  const sections = { needs: [], reminded: [], waiting: [] }
  for (const group of groups.values()) {
    const active = group.items.filter(needsYou)
    const reminded = group.items.filter(putOff)
    const section = active.length ? 'needs' : reminded.length ? 'reminded' : 'waiting'
    // The card's figures are for what it is in its section for: what needs the Admin now, else everything in it.
    const counted = section === 'needs' ? active : group.items
    const items = [...active, ...group.items.filter(booking => !active.includes(booking))]
    sections[section].push({
      ...group, section, items, active, counted,
      first: group.items[0],
      oldest: counted[0].date,
      owed: counted.reduce((sum, booking) => sum + reviewAmount(booking, isExtra), 0),
    })
  }
  const order = (a, b) => a.oldest.localeCompare(b.oldest) || byWhen(a.counted[0], b.counted[0])
  return { needs: sections.needs.sort(order), reminded: sections.reminded.sort(order), waiting: sections.waiting.sort(order) }
}

// "today", "yesterday", "30 days ago", or for a day still to come "Sat 21 Nov".
export function howLongAgo(date, from = today()) {
  if (date === from) return 'today'
  if (date === shiftDate(from, -1)) return 'yesterday'
  if (date > from) return dateLabel(date)
  const days = Math.round((Date.parse(`${from}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86400000)
  return `${days} days ago`
}
