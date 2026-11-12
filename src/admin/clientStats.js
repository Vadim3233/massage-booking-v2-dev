// Client base stats (ADR-099): the words and lists the Clients page and a client's card show. The numbers come from the database
// (admin_client_base, admin_client_rhythm in 20261211100000_client_base_stats.sql); this file only turns them into plain words.

export const TAGS = [
  { key: 'regular', label: 'Regular' },
  { key: 'new', label: 'New' },
  { key: 'quiet', label: 'Quiet' },
  { key: 'lapsed', label: 'Lapsed' },
]
export const tagLabel = tag => TAGS.find(item => item.key === tag)?.label ?? ''

const DAY = 86400000
const parse = iso => new Date(`${iso}T00:00:00Z`)
export const daysBetween = (from, to) => Math.round((parse(to) - parse(from)) / DAY)

// A gap in days as people say it: "every 10 days", "every ~3 weeks", "every ~2 months".
export function gapWords(days) {
  if (days == null) return ''
  if (days < 14) return `every ${Math.max(days, 1)} day${days === 1 ? '' : 's'}`
  if (days < 60) return `every ~${Math.round(days / 7)} weeks`
  return `every ~${Math.round(days / 30)} months`
}
// How long ago, the same way: "5 days ago", "3 weeks ago", "4 months ago".
export function agoWords(days) {
  if (days == null) return ''
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  if (days < 60) return `${Math.round(days / 7)} weeks ago`
  return `${Math.round(days / 30)} months ago`
}
// An overdue gap in weeks for the card's banner, never less than one.
export const overdueWeeks = days => Math.max(1, Math.round(days / 7))

export const shortDate = iso => iso ? parse(iso).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }) : ''
export const monthYear = iso => iso ? parse(iso).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'short', year: 'numeric' }) : ''
export const pounds = value => `£${Math.round(Number(value) || 0).toLocaleString('en-GB')}`

// The four tiles at the top of the Clients page.
export function tiles(base) {
  const month = parse(base.today).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long' })
  const last = new Date(Date.UTC(parse(base.today).getUTCFullYear(), parse(base.today).getUTCMonth() - 1, 1)).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long' })
  const share = base.visited ? Math.round(100 * base.came_back / base.visited) : null
  return [
    { key: 'total', label: 'Clients', value: String(base.total), sub: `${base.active} active in the last 90 days` },
    { key: 'new', label: `New in ${month}`, value: String(base.new_this_month), sub: `${last} had ${base.new_last_month}` },
    { key: 'back', label: 'Came back', value: share == null ? '–' : `${share}%`, sub: share == null ? 'No visits yet' : `${base.came_back} of ${base.visited} booked again` },
    { key: 'gap', label: 'Usual gap', value: base.usual_gap_days == null ? '–' : gapWords(base.usual_gap_days).replace('every ', ''), sub: 'between visits for regulars' },
  ]
}

// The line under a client's name in the list.
export function clientLine(stats, today) {
  if (!stats || !stats.visits) return stats?.next_date ? `No visits yet · booked ${shortDate(stats.next_date)}` : 'No visits yet'
  const parts = [`${stats.visits} visit${stats.visits === 1 ? '' : 's'}`]
  if (stats.visits >= 3 && stats.gap_days != null) parts.push(gapWords(stats.gap_days))
  parts.push(stats.visits === 1 ? shortDate(stats.last_visit) : `last ${shortDate(stats.last_visit)}`)
  if (stats.next_date && stats.next_date >= today) parts.push(`next ${shortDate(stats.next_date)}`)
  return parts.join(' · ')
}

export const tagCounts = clients => Object.fromEntries(TAGS.map(({ key }) => [key, clients.filter(row => row.tag === key).length]))

// The three "Worth a look" lists.
export const goneQuiet = clients => clients.filter(row => row.tag === 'quiet').sort((a, b) => (b.overdue_days ?? 0) - (a.overdue_days ?? 0))
export const newNotBack = (clients, today) => clients
  .filter(row => row.visits === 1 && !row.next_date && row.first_visit && daysBetween(row.first_visit, today) <= 61)
  .sort((a, b) => b.first_visit.localeCompare(a.first_visit))
export const mostLoyal = (clients, by = 'visits', count = 5) => clients
  .filter(row => row.visits > 0)
  .sort((a, b) => by === 'spent' ? Number(b.paid_gbp) - Number(a.paid_gbp) || b.visits - a.visits : b.visits - a.visits || Number(b.paid_gbp) - Number(a.paid_gbp))
  .slice(0, count)

// Search inside a filtered list, on the page, with the same idea as the server's search: name, email, or the digits of a phone number.
export function matches(row, query) {
  const text = query.trim().toLowerCase()
  if (!text) return true
  const name = `${row.first_name ?? ''} ${row.last_name ?? ''}`.toLowerCase()
  const digits = text.replace(/[^0-9]/g, '')
  return name.includes(text) || (row.email ?? '').toLowerCase().includes(text) || (digits !== '' && (row.phone ?? '').replace(/[^0-9]/g, '').includes(digits))
}
