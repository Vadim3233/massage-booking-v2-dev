import { supabase } from '../lib/supabase.js'

// More › Gift vouchers (ADR-101). Until the database update for it is applied (20261214100000_gift_vouchers.sql), the page says so.
export const NOT_SWITCHED_ON = 'Gift vouchers are not switched on yet: the database update for them still has to be applied.'
const missing = error => ['PGRST202', 'PGRST205', '42P01', '42883'].includes(error?.code) || /gift_voucher/.test(error?.message || '')
function failure(error) {
  if (missing(error)) return Object.assign(new Error(NOT_SWITCHED_ON), { notSwitchedOn: true })
  // The database's own sentences for the Admin (they end with a full stop and say what to do).
  if (['22023', 'PT409'].includes(error?.code) && error?.message) return new Error(error.message)
  return new Error('Could not do that. Please check your connection and try again.')
}
async function call(request) {
  const { data, error } = await request
  if (error) throw failure(error)
  return data
}

export function createGiftAdminApi(client) {
  return {
    list: () => call(client.rpc('admin_gift_vouchers')),
    options: () => call(client.rpc('get_gift_options')),
    markPaid: (id, method) => call(client.rpc('admin_mark_gift_paid', { p_voucher_id: id, p_method: method })),
    cancel: id => call(client.rpc('admin_cancel_gift_voucher', { p_voucher_id: id })),
    // The buyer asked for their money back from their gift page (20261217100000): sent, or the money never came.
    refundSent: (id, moneyCame = true) => call(client.rpc('admin_gift_refund_sent', { p_voucher_id: id, p_money_came: moneyCame })),
    markUsed: (id, used) => call(client.rpc('admin_mark_gift_used', { p_voucher_id: id, p_used: used })),
    // More time (until the end of a London day, YYYY-MM-DD), and changing its words or where and when it is emailed (20261216100000).
    extend: (id, day) => call(client.rpc('admin_extend_gift_voucher', { p_voucher_id: id, p_until: day })),
    update: (id, form) => call(client.rpc('admin_update_gift_voucher', {
      p_voucher_id: id, p_recipient_name: form.to.trim(), p_from_name: form.from.trim(), p_message: form.message.trim() || null,
      p_recipient_email: form.email ? form.email.trim() : null, p_send_at: form.sendAt || null,
    })),
    // Receipts, refunds Vadim gives himself, money arriving after a cancel, and the booking page button (20261221100000).
    receipt: id => call(client.rpc('admin_gift_receipt', { p_voucher_id: id })),
    refunded: (id, amount) => call(client.rpc('admin_gift_refunded', { p_voucher_id: id, p_amount: amount })),
    moneyArrived: id => call(client.rpc('admin_gift_money_arrived', { p_voucher_id: id })),
    banner: () => call(client.rpc('get_gift_banner')),
    setBanner: on => call(client.rpc('admin_set_gift_banner', { p_on: on })),
    make: form => call(client.rpc('admin_make_gift_voucher', {
      p_minutes: form.minutes, p_people: form.people, p_travel_choice: form.travel, p_service_area_id: form.areaId || null, p_design: form.design,
      p_recipient_name: form.to.trim(), p_from_name: form.from.trim() || null, p_message: form.message.trim() || null,
      p_buyer_name: form.buyerName.trim() || null, p_buyer_email: form.buyerEmail.trim() || null, p_method: form.method,
      p_price_gbp: form.price === '' ? null : Number(form.price),
    })),
  }
}
export const giftAdminApi = createGiftAdminApi(supabase)

// The groups on the page, in the order Vadim deals with them, and the figures at the top. Nothing is ever dropped: refunded and
// cancelled vouchers have their own groups at the bottom.
const booked = v => v.status === 'used' && v.booking && !v.booking.started && !['cancelled', 'no_show'].includes(v.booking.status)
export function giftGroups(list, now = Date.now()) {
  const refunds = list.filter(v => v.refund_to_send)
  const waiting = list.filter(v => v.status === 'awaiting_payment')
  const ready = list.filter(v => v.status === 'ready' && !v.expired)
  const bookedList = list.filter(booked)
  const ended = list.filter(v => v.status === 'ready' && v.expired)
  const used = list.filter(v => v.status === 'used' && !booked(v))
  const refunded = list.filter(v => v.status === 'cancelled' && v.paid_at && !v.refund_to_send)
  const cancelled = list.filter(v => v.status === 'cancelled' && !v.paid_at && !v.refund_to_send)
  const yearAgo = now - 365 * 86400000
  const within = at => at && Date.parse(at) > yearAgo
  const sum = (items, value) => items.reduce((total, v) => total + Number(value(v) || 0), 0)
  const sold = list.filter(v => within(v.paid_at))
  const held = [...ready, ...bookedList, ...refunds.filter(v => v.paid_at)]
  return {
    refunds, waiting, ready, booked: bookedList, ended, used, refunded, cancelled,
    // Money that came in for vouchers in the last 12 months (refunded ones too: the refund is its own figure).
    soldCount: sold.length, soldTotal: sum(sold, v => v.price_gbp),
    usedTotal: sum(used.filter(v => within(v.booking?.date ? `${v.booking.date}T12:00:00Z` : v.used_at)), v => v.price_gbp),
    endedTotal: sum(ended.filter(v => within(v.expires_at)), v => v.price_gbp),
    refundedTotal: sum(list.filter(v => within(v.refunded_at)), v => v.refund_gbp),
    heldCount: held.length, heldTotal: sum(held, v => v.price_gbp),
  }
}

const shortDay = iso => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' }).format(new Date(iso))
const pounds = value => `£${Number(value).toFixed(Number(value) % 1 ? 2 : 0)}`
// The pill on each voucher: where it stands, in a word or three, and its colour (ok, needs, done, cancel).
export function giftState(v) {
  if (v.refund_to_send) return { label: 'Refund to send', tone: 'needs' }
  if (v.status === 'awaiting_payment') return { label: 'Waiting for payment', tone: 'needs' }
  if (v.status === 'ready') return v.expired ? { label: 'Ended unused', tone: 'done' } : { label: 'Ready', tone: 'ok' }
  if (v.status === 'used') {
    if (booked(v)) return { label: `Booked for ${shortDay(`${v.booking.date}T12:00:00Z`)}`, tone: 'ok' }
    if (v.booking?.status === 'cancelled') return { label: 'Used up (late cancel)', tone: 'done' }
    if (v.booking?.status === 'no_show') return { label: 'Used up (missed)', tone: 'done' }
    const at = v.booking?.date ? `${v.booking.date}T12:00:00Z` : v.used_at
    return { label: at ? `Used ${shortDay(at)}` : 'Used', tone: 'done' }
  }
  if (v.refunded_at && Number(v.refund_gbp) > 0) return { label: `Refunded ${pounds(v.refund_gbp)}`, tone: 'cancel' }
  if (!v.paid_at) return { label: 'Cancelled, not paid', tone: 'cancel' }
  return { label: 'Cancelled', tone: 'cancel' }
}

// On a client's page: the vouchers this client bought (matched by their email), newest first, leaving out cancelled ones.
export function boughtBy(list, email) {
  const wanted = String(email || '').trim().toLowerCase()
  if (!wanted) return []
  return (list || []).filter(v => v.status !== 'cancelled' && String(v.buyer_email || '').trim().toLowerCase() === wanted)
}

// Search on Gift vouchers: a code typed any way (7k3m qx9p, 7K3M-QX9P), the bank reference, or part of a name or email.
const letters = text => String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
export function matchesSearch(voucher, search) {
  const text = String(search || '').trim().toLowerCase()
  if (!text) return true
  const typed = letters(text)
  if (typed.length >= 4 && (letters(voucher.code).includes(typed) || letters(voucher.payment_reference).includes(typed))) return true
  return [voucher.recipient_name, voucher.from_name, voucher.buyer_name, voucher.buyer_email, voucher.buyer_phone, voucher.recipient_email, voucher.booking?.client_name]
    .some(value => String(value || '').toLowerCase().includes(text))
}

const day = iso => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' }).format(new Date(iso))
const WHO = { admin: 'You', buyer: 'Buyer', client: 'Client', system: 'Automatic' }
// A voucher's story, oldest first, as the database recorded it (20261221100000), with who did each thing; plus "Ended unused" once its
// time is up. A list from before that update has no history, so its story is pieced together from its dates.
export function giftHistory(v, now = Date.now()) {
  if (Array.isArray(v.history) && v.history.length) {
    const steps = v.history.map(h => ({ at: h.at, day: day(h.at), text: h.words, who: WHO[h.actor] || '' }))
    if (v.status === 'ready' && v.expires_at && Date.parse(v.expires_at) <= now) steps.push({ at: v.expires_at, day: day(v.expires_at), text: 'Ended unused', who: 'Automatic' })
    return steps.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  }
  const steps = [[v.created_at, v.created_by === 'admin' ? 'Made by you' : `Bought online by ${v.buyer_name}`]]
  if (v.transfer_declared_at) steps.push([v.transfer_declared_at, 'Buyer said the transfer is made'])
  if (v.paid_at) steps.push([v.paid_at, `Paid (${v.payment_method === 'cash' ? 'cash' : 'bank transfer'}), voucher ready`])
  if (v.recipient_sent_at) steps.push([v.recipient_sent_at, `Emailed to ${v.recipient_email}`])
  if (v.reminder_sent_at) steps.push([v.reminder_sent_at, 'Reminder sent: a month left'])
  if (v.booking) steps.push([v.used_at || v.updated_at, `Booked by ${v.booking.client_name || 'a client'} for ${day(`${v.booking.date}T12:00:00Z`)}`])
  else if (v.status === 'used') steps.push([v.used_at || v.updated_at, 'Marked used by you'])
  if (v.status === 'cancelled') steps.push([v.updated_at, 'Cancelled'])
  if (v.status === 'ready' && v.expires_at && Date.parse(v.expires_at) <= now) steps.push([v.expires_at, 'Ended unused'])
  return steps.filter(([at]) => at).sort((a, b) => Date.parse(a[0]) - Date.parse(b[0])).map(([at, text]) => ({ at, day: day(at), text, who: '' }))
}

// Every voucher as a spreadsheet, for your records or your accountant.
const cell = value => {
  const text = String(value ?? '')
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
const dateOnly = iso => (iso ? new Date(iso).toISOString().slice(0, 10) : '')
export function giftCsv(list) {
  const lines = [['Code', 'Bank reference', 'Receipt', 'State', 'Gift', 'For', 'From', 'Buyer', 'Buyer email', 'Price', 'Paid by', 'Paid on', 'Valid until',
    'Booked by', 'Session date', 'Booking reference', 'Used on', 'Ended on', 'Refunded on', 'Refund']]
  for (const v of list) {
    const usedOn = v.status === 'used' ? (v.booking?.date || dateOnly(v.used_at)) : ''
    lines.push([v.code_shown || v.code, v.payment_reference, v.receipt_number || '', giftState(v).label, `${v.minutes} min${v.people === 2 ? ' for two' : ''}`,
      v.recipient_name, v.from_name, v.buyer_name, v.buyer_email || '', Number(v.price_gbp).toFixed(2), v.payment_method === 'cash' ? 'Cash' : v.payment_method ? 'Bank transfer' : '',
      dateOnly(v.paid_at), dateOnly(v.expires_at), v.booking?.client_name || '', v.booking?.date || '', v.booking?.reference || '', usedOn,
      v.status === 'ready' && v.expired ? dateOnly(v.expires_at) : '', dateOnly(v.refunded_at), v.refunded_at ? Number(v.refund_gbp || 0).toFixed(2) : ''])
  }
  return lines.map(line => line.map(cell).join(',')).join('\r\n') + '\r\n'
}
