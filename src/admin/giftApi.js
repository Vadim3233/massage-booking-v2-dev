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
    markUsed: (id, used) => call(client.rpc('admin_mark_gift_used', { p_voucher_id: id, p_used: used })),
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
  const waiting = list.filter(v => v.status === 'awaiting_payment')
  const ready = list.filter(v => v.status === 'ready')
  const used = list.filter(v => v.status === 'used')
  const yearAgo = now - 365 * 86400000
  const sold = list.filter(v => v.paid_at && Date.parse(v.paid_at) > yearAgo && v.status !== 'cancelled')
  return { waiting, ready, used, soldCount: sold.length, soldTotal: sold.reduce((sum, v) => sum + Number(v.price_gbp), 0) }
}

// On a client's page: the vouchers this client bought (matched by their email), newest first, leaving out cancelled ones.
export function boughtBy(list, email) {
  const wanted = String(email || '').trim().toLowerCase()
  if (!wanted) return []
  return (list || []).filter(v => v.status !== 'cancelled' && String(v.buyer_email || '').trim().toLowerCase() === wanted)
}
