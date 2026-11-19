import { dateLabel, label, money, time, today } from './calendarPresentation.js'
import { alertDayHeading, bookingIdFromLink } from './alertsApi.js'
import { shortMoney, summariseAlert } from './alertSummary.js'
import { minutesWords } from './extendApi.js'

// How one line of the record reads (ADR-107): what happened (bold), who it was about and which day, who did it (Client, You, Automatic,
// Buyer), and, for a change, the old value crossed out beside the new one. A client's action that raised an alert reads as the alert always
// did; everything else is worded here. Anything not known here still shows, under a plain name, so nothing is ever hidden.

export const WHO = { client: 'Client', admin: 'You', system: 'Automatic', buyer: 'Buyer' }
const short = date => (date ? dateLabel(date, { weekday: 'short', day: 'numeric', month: 'short' }) : '')
const when = (date, minutes) => (date ? `${short(date)} ${time(Number(minutes) || 0)}` : '')
const pounds = value => (value === null || value === undefined || value === '' ? '' : shortMoney(money(value)))
const METHOD = { bank_transfer: 'Bank transfer', cash: 'Cash' }

// [what happened, icon kind]. A function gets the line and says it in its own words.
const EVENTS = {
  'booking.created': row => [row.actor === 'admin' ? 'Booking added' : row.via === 'ai' ? 'Booked through their AI assistant' : 'New booking', 'booking'],
  'booking.rescheduled': row => [row.actor === 'client' ? 'Moved their appointment' : 'Moved', 'move'],
  'booking.services_changed': row => [row.actor === 'client' ? 'Changed their booking' : 'Booking changed', 'edit'],
  'booking.cancelled': () => ['Cancelled', 'cancel'],
  'booking.transfer_declared': () => ['Transfer made', 'bank'],
  'booking.cash_requested': () => ['Wants to pay cash', 'cash'],
  'booking.payment_method_changed': row => [`Changed to ${row.payload?.method === 'cash' ? 'cash' : 'bank transfer'}`, 'cash'],
  'booking.bank_transfer_received': () => ['Marked paid', 'bank'],
  'booking.bank_transfer_verified': () => ['Transfer checked · confirmed', 'bank'],
  'booking.cash_approved': () => ['Confirmed · paying cash', 'cash'],
  'booking.cash_rejected': () => ['Said no to cash', 'cash'],
  'booking.cash_received': () => ['Cash received', 'cash'],
  'booking.confirmed_payment_due': () => ['Confirmed · paying later', 'booking'],
  'booking.confirmed_pay_after': () => ['Next session confirmed', 'booking'],
  'booking.next_payment_due': () => ['Next session to pay', 'bank'],
  'booking.pending_removed': () => ['Request declined', 'cancel'],
  'booking.refund_recorded': () => ['Refund sent', 'bank'],
  'booking.late_fee_settled': row => [row.payload?.action === 'received' ? 'Late fee received' : 'Late fee waived', 'cash'],
  'booking.balance_received': () => ['Extra payment received', 'bank'],
  'booking.extra_reported': () => ['Says they sent the extra', 'bank'],
  'booking.extended': row => [`Extra time · +${minutesWords(Number(row.payload?.minutes) || 0)}`, 'clock'],
  'booking.extension_removed': row => [`Extra time removed · ${minutesWords(Number(row.payload?.minutes) || 0)}`, 'clock'],
  'booking.completed': () => ['Marked completed', 'check'],
  'booking.no_show': () => ['Marked no-show', 'cancel'],
  'booking.address_changed': () => ['Address changed', 'pin'],
  'booking.receipt_issued': row => [`Receipt made${row.payload?.number ? ` · ${row.payload.number}` : ''}`, 'receipt'],
  'booking.receipt_emailed': () => ['Receipt emailed', 'receipt'],
  'booking.receipt_edited': () => ['Receipt corrected', 'receipt'],
  'booking.reminder': () => ['Reminder sent', 'send'],
  'booking.review_request': () => ['Google review invite sent', 'send'],
  'booking.series_due': () => ['Next repeat booking made', 'booking'],
  'booking.pay_after_requested': () => ['Asked to pay session by session', 'bank'],
  'series.clash': () => ['Repeat booking clashes', 'booking'],
  'client.details_changed': () => ['Contact details changed', 'people'],
  'client.note_added': row => [row.note ? 'Note added' : 'Note added (since deleted)', 'people'],
  'client.possible_duplicate': () => ['Is this the same person?', 'people'],
  'waitlist.joined': () => ['Joined the waitlist', 'booking'],
  'gift.bought': () => ['New gift voucher', 'gift'],
  'gift.transfer_declared': () => ['Gift voucher transfer made', 'gift'],
  'gift.ready': () => ['Gift voucher paid', 'gift'],
  'gift.arrived': () => ['Gift voucher sent to the recipient', 'gift'],
  'gift.reminder': () => ['Gift voucher reminder sent', 'gift'],
  'gift.refund_requested': () => ['Asked for a gift voucher refund', 'gift'],
  'gift.buyer_cancelled': () => ['Cancelled a gift voucher', 'gift'],
  'gift.cancelled': () => ['Gift voucher cancelled', 'gift'],
  'gift.refund_sent': () => ['Gift voucher refund sent', 'gift'],
  'gift.marked_used': () => ['Gift voucher marked used', 'gift'],
  'gift.not_used': () => ['Gift voucher not used after all', 'gift'],
  'gift.extended': () => ['Gift voucher extended', 'gift'],
  'gift.changed': () => ['Gift voucher details changed', 'gift'],
  'gift.money_arrived': () => ['Gift voucher money arrived after the cancel', 'gift'],
  'status.changed': row => [`${row.payload?.entity === 'payment' ? 'Payment' : 'Booking'}: ${label(row.payload?.to_status)}`, 'booking'],
}
const plainName = type => {
  const words = String(type || 'Something happened').split('.').pop().replaceAll('_', ' ')
  return words[0].toUpperCase() + words.slice(1)
}

// What changed, old → new.
function changesOf(row) {
  const p = row.payload || {}
  switch (row.event_type) {
    case 'booking.rescheduled':
      return p.from_date ? [{ key: 'time', from: when(p.from_date, p.from_start_minutes), to: when(p.to_date, p.to_start_minutes) }] : []
    case 'booking.services_changed': {
      const list = []
      if (p.previous_total_gbp != null && p.total_gbp != null && Number(p.previous_total_gbp) !== Number(p.total_gbp)) list.push({ key: 'price', from: pounds(p.previous_total_gbp), to: pounds(p.total_gbp) })
      if (p.from_date && (p.from_date !== p.to_date || Number(p.from_start_minutes) !== Number(p.to_start_minutes))) list.push({ key: 'time', from: when(p.from_date, p.from_start_minutes), to: when(p.to_date, p.to_start_minutes) })
      return list
    }
    case 'booking.cash_requested': return [{ key: 'method', from: 'Bank transfer', to: 'Cash' }]
    case 'booking.payment_method_changed': return p.previous_method ? [{ key: 'method', from: METHOD[p.previous_method] || label(p.previous_method), to: METHOD[p.method] || label(p.method) }] : []
    case 'booking.address_changed': return p.previous_address ? [{ key: 'address', from: p.previous_address, to: row.next_address || '' }] : []
    case 'client.details_changed':
      return Object.entries(p.changes || {}).map(([key, change]) => ({ key, from: change?.from || '(none)', to: change?.to || '(none)' }))
    case 'status.changed': return p.from_status ? [{ key: 'status', from: label(p.from_status), to: label(p.to_status) }] : []
    default: return []
  }
}

// Short notes beside the line: who asked, money still to settle, a message that did not go.
const STARTS = ['booking.created', 'gift.bought', 'gift.transfer_declared', 'gift.ready']
function tagsOf(row) {
  const p = row.payload || {}
  const tags = []
  if (row.actor === 'admin' && p.initiated_by === 'client' && ['booking.rescheduled', 'booking.cancelled'].includes(row.event_type)) tags.push({ text: 'client asked' })
  if (row.late) tags.push({ text: 'late', tone: 'late' })
  if (['booking.cancelled', 'booking.rescheduled', 'booking.services_changed'].includes(row.event_type) && !row.alert_id) {
    if (Number(p.late_fee_due_gbp) > 0) tags.push({ text: `late fee ${pounds(p.late_fee_due_gbp)}` })
    if (Number(p.refund_due_gbp) > 0) tags.push({ text: `refund ${pounds(p.refund_due_gbp)}` })
    if (Number(p.balance_due_gbp) > 0) tags.push({ text: `${pounds(p.balance_due_gbp)} still to pay` })
  }
  if (row.event_type === 'booking.extended' && p.pay_by) tags.push({ text: { bill: 'added to the bill', cash: 'cash', transfer: 'by transfer', free: 'no charge' }[p.pay_by] || p.pay_by })
  if ((row.sent || []).some(item => item.status === 'failed')) tags.push({ text: 'not sent', tone: 'late' })
  // A booking or gift that was cancelled later says so on the line that started it, so an old "New gift voucher" does not look live.
  if (STARTS.includes(row.event_type) && (p.gift_status === 'cancelled' || row.booking_status === 'cancelled')) tags.push({ text: 'cancelled since' })
  return tags
}

// The amount on the right.
function amountOf(row) {
  const p = row.payload || {}
  const value = { 'booking.bank_transfer_received': p.amount_gbp, 'booking.bank_transfer_verified': p.amount_gbp, 'booking.cash_approved': p.amount_gbp,
    'booking.cash_received': p.amount_gbp, 'booking.refund_recorded': p.refunded_gbp ?? p.refund_due_gbp, 'booking.balance_received': p.received_gbp,
    'booking.extended': p.price_gbp, 'booking.extension_removed': p.price_gbp, 'booking.services_changed': p.total_gbp,
    'booking.late_fee_settled': p.action === 'received' ? p.late_fee_due_gbp : undefined }[row.event_type]
  if (value !== undefined && value !== null) return pounds(value)
  if (row.event_type?.startsWith('client.') || row.event_type?.startsWith('gift.') || row.event_type === 'booking.reminder' || row.event_type === 'booking.review_request') return ''
  return row.booking_total != null ? pounds(row.booking_total) : ''
}

export function describeLine(row) {
  const known = EVENTS[row.event_type]
  const [ownWhat, ownKind] = known ? known(row) : [plainName(row.event_type), 'other']
  // A client's action that raised an alert reads the way the alert always read.
  const alert = row.alert_id ? summariseAlert({ title: row.alert_title, body: row.alert_body }) : null
  const what = alert && (!known || row.event_type === 'alert' || alert.kind !== 'other') ? alert.what : ownWhat
  const kind = alert && alert.kind !== 'other' && !['move', 'edit'].includes(ownKind) ? alert.kind : ownKind
  const changes = changesOf(row)
  // Who it was about, and the day, unless the change line already says the day.
  const dayShown = changes.length > 0 && ['booking.rescheduled'].includes(row.event_type)
  // The day the booking was for at that moment, where the line knows it (a booking made for Thu 19 Nov, later moved, still says Thu 19 Nov).
  const bookedFor = row.payload?.to_date || row.payload?.date || row.booking_date
  const day = bookedFor && !dayShown && !row.event_type?.startsWith('client.') ? short(bookedFor) : ''
  const who = [row.name || (alert ? alert.who : ''), day].filter(Boolean).join(' · ')
  const amount = alert?.amount && row.event_type === 'alert' ? alert.amount : amountOf(row) || alert?.amount || ''
  return {
    what, kind, who, amount, changes, tags: tagsOf(row),
    actor: row.actor, actorLabel: row.via === 'ai' ? 'Client · via AI' : WHO[row.actor] || 'Automatic',
    note: row.note || (row.event_type === 'client.note_added' ? row.payload?.note : '') || '',
    before: row.event_type === 'booking.services_changed' && row.payload?.previous_sessions ? `Before: ${row.payload.previous_sessions}` : '',
    // Gold until read: something a client did that raised an alert. Quiet: what Vadim or the app did.
    alert: Boolean(row.alert_id), unread: Boolean(row.alert_id) && !row.alert_read_at,
    bookingId: row.booking_id || bookingIdFromLink(row.alert_link) || null,
    link: row.alert_link || null,
  }
}

// The same person changing the same booking several times within 10 minutes reads as one line ("moved 3×"), from the first old value to
// the last new one. Each change is still its own line in the booking's History. The rows come newest first.
const REPEATS = ['booking.rescheduled', 'booking.services_changed', 'client.details_changed']
const TEN_MINUTES = 10 * 60 * 1000
export function mergeRepeats(rows) {
  const items = []
  for (const row of rows) {
    const last = items.at(-1)
    const newest = last?.rows[0]
    // Within 10 minutes of the newest change of the group, so a chain of changes never stretches the group on and on.
    const same = last && REPEATS.includes(row.event_type) && newest.event_type === row.event_type && newest.actor === row.actor
      && (row.booking_id ? newest.booking_id === row.booking_id : newest.client_id && newest.client_id === row.client_id)
      && Math.abs(new Date(newest.at) - new Date(row.at)) <= TEN_MINUTES
    if (same) last.rows.push(row)
    else items.push({ id: row.id, rows: [row] })
  }
  return items.map(item => {
    const head = item.rows[0]
    const line = describeLine(head)
    if (item.rows.length > 1) {
      // Each thing that changed (time, price, phone…), from what it was before its first change to what it is after its last.
      const byKey = new Map()
      for (const row of [...item.rows].reverse()) {
        for (const change of describeLine(row).changes) {
          const seen = byKey.get(change.key)
          byKey.set(change.key, { key: change.key, from: seen ? seen.from : change.from, to: change.to })
        }
      }
      line.changes = [...byKey.values()]
      line.times = item.rows.length
      line.tags = [...line.tags, ...item.rows.slice(1).flatMap(row => describeLine(row).tags)].filter((tag, index, all) => all.findIndex(other => other.text === tag.text) === index)
    }
    return { ...item, head, line, at: head.at, unreadIds: item.rows.filter(row => row.alert_id && !row.alert_read_at).map(row => row.alert_id) }
  })
}

// Lines under the London day they happened, newest day first.
const londonDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value))
export function linesByDay(items, from = today()) {
  const days = []
  for (const item of items) {
    const date = londonDay(item.at)
    let day = days.at(-1)
    if (day?.date !== date) { day = { date, ...alertDayHeading(date, from), items: [], unread: 0 }; days.push(day) }
    day.items.push(item)
    if (item.unreadIds.length) day.unread += 1
  }
  return days
}

// "16 Nov 07:41", for the booking's History, where lines span many days.
export const stamp = value => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)).replace(',', '')
export const clock = value => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }).format(new Date(value))

// "7 things · moved 2×" over a booking's History.
export function storySummary(rows) {
  const moves = rows.filter(row => row.event_type === 'booking.rescheduled').length
  return [`${rows.length} ${rows.length === 1 ? 'thing' : 'things'}`, moves > 1 ? `moved ${moves}×` : moves === 1 ? 'moved once' : ''].filter(Boolean).join(' · ')
}
