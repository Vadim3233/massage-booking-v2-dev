// Alerts in two short lines, the way the Alerts page shows them: what happened (bold), then who, which day and how much, with an icon
// for the kind of alert. Alerts are written in the database with a full sentence for a title; this reads that sentence back. An alert
// it does not recognise keeps its own title, so nothing is ever hidden.

// "<name> says the transfer is made" and the like: the name, then what they did.
const BY_NAME = [
  [' says the gift voucher transfer is made', 'Gift voucher transfer made', 'gift'],
  [' asked for a gift voucher refund', 'Asked for a gift voucher refund', 'gift'],
  [' cancelled a gift voucher before paying', 'Cancelled a gift voucher', 'gift'],
  [' says the transfer is made', 'Transfer made', 'bank'],
  [' says they sent the extra', 'Says they sent the extra', 'bank'],
  [' would like to pay cash', 'Wants to pay cash', 'cash'],
  [' booked another session', 'Booked another session', 'booking'],
  [' moved their appointment', 'Moved their appointment', 'booking'],
  [' changed their booking', 'Changed their booking', 'booking'],
  [' cancelled', 'Cancelled', 'cancel'],
]
const DAY = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g
const MONEY = /£\d[\d,]*(?:\.\d\d)?/

// £125.00 reads as £125; £108.50 stays as it is.
export const shortMoney = text => text?.replace(/\.00$/, '') || ''

export function summariseAlert(alert) {
  const title = String(alert?.title || '').trim()
  const body = String(alert?.body || '')
  const days = body.match(DAY) || []
  const amount = shortMoney((title.match(MONEY) || body.match(MONEY) || [])[0])
  const line = (what, kind, who = '', day = days[0] || '') => ({ what, kind, who: [who, day].filter(Boolean).join(' · '), amount })
  for (const [ending, what, kind] of BY_NAME) {
    if (title.endsWith(ending) && title.length > ending.length) {
      // A move names the old time, then the new one: the new one is the day that matters.
      return line(what, kind, title.slice(0, -ending.length), ending === ' moved their appointment' ? days.at(-1) : days[0])
    }
  }
  // "New booking request" (and its versions: with a gift voucher, outside your areas, no postcode): the body starts "<name>: <day>…".
  if (/^New booking( request)?\b/.test(title)) {
    const who = /^([^:\n]{1,80}):/.exec(body)?.[1] || ''
    return line(title, 'booking', who)
  }
  const gift = /^New gift voucher: (£\S+) by (.+)$/.exec(title)
  if (gift) return line('New gift voucher', 'gift', /^(.{1,80}?) is buying /.exec(body)?.[1] || '', gift[2])
  const repeat = /^Next repeat booking for (.+)$/.exec(title)
  if (repeat) return line('Next repeat booking', 'booking', repeat[1])
  if (title === 'Is this the same person?') return { what: title, kind: 'people', who: '', amount: '' }
  if (title === 'Someone joined the waitlist') return line('Someone joined the waitlist', 'booking')
  return { what: title || 'Alert', kind: 'other', who: '', amount: '' }
}

// The words on the button that opens what an alert is about.
export function openLabel(link) {
  if (/^\/admin\/bookings\//.test(link || '')) return 'Open booking'
  if (/^\/admin\/gifts/.test(link || '')) return 'Open gift vouchers'
  if (/^\/admin\/clients\/combine/.test(link || '')) return 'Compare them'
  if (/^\/admin\/clients\//.test(link || '')) return 'Open client'
  if (/^\/admin\/waitlist/.test(link || '')) return 'Open waitlist'
  if (/^\/admin\/income/.test(link || '')) return 'Open Income'
  return 'Open'
}
