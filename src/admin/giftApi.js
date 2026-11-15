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
    make: form => call(client.rpc('admin_make_gift_voucher', {
      p_minutes: form.minutes, p_people: form.people, p_travel_choice: form.travel, p_service_area_id: form.areaId || null, p_design: form.design,
      p_recipient_name: form.to.trim(), p_from_name: form.from.trim() || null, p_message: form.message.trim() || null,
      p_buyer_name: form.buyerName.trim() || null, p_buyer_email: form.buyerEmail.trim() || null, p_method: form.method,
      p_price_gbp: form.price === '' ? null : Number(form.price),
    })),
  }
}
export const giftAdminApi = createGiftAdminApi(supabase)

// The groups on the page, in the order Vadim deals with them.
export function giftGroups(list, now = Date.now()) {
  // Buyers who cancelled and are owed their money back (20261217100000).
  const refunds = list.filter(v => v.refund_to_send)
  const waiting = list.filter(v => v.status === 'awaiting_payment')
  const ready = list.filter(v => v.status === 'ready' && !v.expired)
  const ended = list.filter(v => v.status === 'ready' && v.expired)
  const used = list.filter(v => v.status === 'used')
  const yearAgo = now - 365 * 86400000
  const sold = list.filter(v => v.paid_at && Date.parse(v.paid_at) > yearAgo && v.status !== 'cancelled')
  return { refunds, waiting, ready, ended, used, soldCount: sold.length, soldTotal: sold.reduce((sum, v) => sum + Number(v.price_gbp), 0) }
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
// A voucher's story, oldest first: who made it, when it was paid and sent, when it was booked or used.
export function giftHistory(v, now = Date.now()) {
  const steps = [[v.created_at, v.created_by === 'admin' ? 'Made by you' : `Bought online by ${v.buyer_name}`]]
  if (v.transfer_declared_at) steps.push([v.transfer_declared_at, 'Buyer said the transfer is made'])
  if (v.paid_at) steps.push([v.paid_at, `Paid (${v.payment_method === 'cash' ? 'cash' : 'bank transfer'}), voucher ready`])
  if (v.recipient_sent_at) steps.push([v.recipient_sent_at, `Emailed to ${v.recipient_email}`])
  if (v.reminder_sent_at) steps.push([v.reminder_sent_at, 'Reminder sent: a month left'])
  if (v.booking) steps.push([v.used_at || v.updated_at, `Booked by ${v.booking.client_name || 'a client'} for ${day(`${v.booking.date}T12:00:00Z`)}`])
  else if (v.status === 'used') steps.push([v.used_at || v.updated_at, 'Marked used by you'])
  if (v.status === 'cancelled') steps.push([v.updated_at, 'Cancelled'])
  if (v.status === 'ready' && v.expires_at && Date.parse(v.expires_at) <= now) steps.push([v.expires_at, 'Ended unused'])
  return steps.filter(([at]) => at).sort((a, b) => Date.parse(a[0]) - Date.parse(b[0])).map(([at, text]) => ({ at, day: day(at), text }))
}

// Every voucher as a spreadsheet, for your records or your accountant.
const cell = value => {
  const text = String(value ?? '')
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
const dateOnly = iso => (iso ? new Date(iso).toISOString().slice(0, 10) : '')
const STATE = { awaiting_payment: 'Waiting for payment', ready: 'Ready to use', used: 'Used', cancelled: 'Cancelled' }
export function giftCsv(list) {
  const lines = [['Code', 'Bank reference', 'State', 'Gift', 'For', 'From', 'Buyer', 'Buyer email', 'Price', 'Paid by', 'Paid on', 'Valid until', 'Booked by', 'Session date']]
  for (const v of list) {
    lines.push([v.code_shown || v.code, v.payment_reference, v.expired ? 'Ended' : STATE[v.status] || v.status, `${v.minutes} min${v.people === 2 ? ' for two' : ''}`,
      v.recipient_name, v.from_name, v.buyer_name, v.buyer_email || '', Number(v.price_gbp).toFixed(2), v.payment_method === 'cash' ? 'Cash' : v.payment_method ? 'Bank transfer' : '',
      dateOnly(v.paid_at), dateOnly(v.expires_at), v.booking?.client_name || '', v.booking?.date || ''])
  }
  return lines.map(line => line.map(cell).join(',')).join('\r\n') + '\r\n'
}
