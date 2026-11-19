import { describe, expect, it } from 'vitest'
import { boughtBy, createGiftAdminApi, giftCsv, giftGroups, giftHistory, giftState, matchesSearch, NOT_SWITCHED_ON } from './giftApi.js'

const client = result => ({ rpc: async (name, args) => (typeof result === 'function' ? result(name, args) : result) })

describe('More › Gift vouchers', () => {
  it('groups the vouchers and counts what was sold in the last year', () => {
    const now = Date.parse('2026-12-01T12:00:00Z')
    const list = [
      { status: 'awaiting_payment', price_gbp: 90, paid_at: null },
      { status: 'ready', price_gbp: 125, paid_at: '2026-11-20T10:00:00Z' },
      { status: 'used', price_gbp: 180, paid_at: '2026-02-01T10:00:00Z' },
      { status: 'used', price_gbp: 90, paid_at: '2025-06-01T10:00:00Z' },
      { status: 'ready', expired: true, price_gbp: 90, paid_at: '2025-11-01T10:00:00Z' },
    ]
    const groups = giftGroups(list, now)
    expect([groups.waiting.length, groups.ready.length, groups.ended.length, groups.used.length]).toEqual([1, 1, 1, 2])
    expect([groups.soldCount, groups.soldTotal]).toEqual([2, 305])
  })
  it('lists buyers who cancelled and are owed their money back, and records the refund', async () => {
    const groups = giftGroups([{ status: 'cancelled', refund_to_send: true, price_gbp: 90, paid_at: '2026-11-20T10:00:00Z' }, { status: 'cancelled', refund_to_send: false }], Date.parse('2026-12-01T12:00:00Z'))
    expect(groups.refunds).toHaveLength(1)
    // Sold counts the money that came in; the refund is its own figure.
    expect(groups.soldCount).toBe(1)
    expect([groups.heldCount, groups.heldTotal]).toEqual([1, 90])
    let sent
    await createGiftAdminApi(client((name, args) => { sent = [name, args]; return { data: {}, error: null } })).refundSent('v1', false)
    expect(sent).toEqual(['admin_gift_refund_sent', { p_voucher_id: 'v1', p_money_came: false }])
  })
  it('says plainly when the database update is not applied yet', async () => {
    const api = createGiftAdminApi(client({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.admin_gift_vouchers' } }))
    await expect(api.list()).rejects.toThrow(NOT_SWITCHED_ON)
  })
  it('passes on the database\'s own words, and hides the rest', async () => {
    await expect(createGiftAdminApi(client({ data: null, error: { code: 'PT409', message: 'That voucher has already been used, so it can\'t be cancelled.' } })).cancel('x'))
      .rejects.toThrow('already been used')
    await expect(createGiftAdminApi(client({ data: null, error: { code: '500', message: 'boom' } })).cancel('x')).rejects.toThrow('Could not do that')
  })
  it('sends a hand-made voucher\'s details', async () => {
    let sent
    const api = createGiftAdminApi(client((name, args) => { sent = [name, args]; return { data: { id: 'v' }, error: null } }))
    await api.make({ minutes: 60, people: 1, travel: 'none', areaId: '', design: 'gold_foil', to: ' Sam ', from: '', message: '', buyerName: 'Jo', buyerEmail: '', method: 'cash', price: '' })
    expect(sent[0]).toBe('admin_make_gift_voucher')
    expect(sent[1]).toMatchObject({ p_recipient_name: 'Sam', p_from_name: null, p_method: 'cash', p_price_gbp: null, p_service_area_id: null })
  })

  it('finds the vouchers a client bought by their email, leaving out cancelled ones', () => {
    const list = [{ id: 1, buyer_email: 'Ana@Example.test', status: 'ready' }, { id: 2, buyer_email: 'ana@example.test', status: 'cancelled' },
      { id: 3, buyer_email: 'bo@example.test', status: 'ready' }, { id: 4, buyer_email: null, status: 'used' }]
    expect(boughtBy(list, ' ana@example.test ').map(v => v.id)).toEqual([1])
    expect(boughtBy(list, '')).toEqual([])
  })
  const voucher = { code: '7K3MQX9P', code_shown: '7K3M-QX9P', payment_reference: 'GIFT-ABCD2345', recipient_name: 'Sarah Jones', from_name: 'Tom', buyer_name: 'Tom Jones',
    buyer_email: 'tom@example.test', status: 'used', minutes: 90, people: 1, price_gbp: 125, payment_method: 'bank_transfer', created_by: 'buyer',
    created_at: '2026-11-15T09:00:00Z', transfer_declared_at: '2026-11-15T09:05:00Z', paid_at: '2026-11-16T10:00:00Z', expires_at: '2027-11-16T10:00:00Z',
    used_at: '2026-12-02T18:00:00Z', updated_at: '2026-12-02T18:00:00Z', booking: { id: 'b', date: '2027-01-03', client_name: 'Sarah Jones' } }

  it('finds a voucher by its code typed any way, its bank reference, or a name or email', () => {
    for (const typed of ['7k3m qx9p', '7K3M-QX9P', 'qx9p', 'gift-abcd2345', 'sarah', 'TOM@example', 'jones']) expect(matchesSearch(voucher, typed)).toBe(true)
    for (const typed of ['7K3M-QX9X', 'anna', 'zz']) expect(matchesSearch(voucher, typed)).toBe(false)
    expect(matchesSearch(voucher, '  ')).toBe(true)
  })

  it('tells a voucher\'s story in order', () => {
    expect(giftHistory(voucher).map(step => step.text)).toEqual(['Bought online by Tom Jones', 'Buyer said the transfer is made',
      'Paid (bank transfer), voucher ready', 'Booked by Sarah Jones for 3 Jan 2027'])
    const handMade = { ...voucher, created_by: 'admin', status: 'ready', booking: null, used_at: null, transfer_declared_at: null, payment_method: 'cash', expires_at: '2026-11-20T00:00:00Z' }
    expect(giftHistory(handMade, Date.parse('2026-12-01T00:00:00Z')).map(step => step.text)).toEqual(['Made by you', 'Paid (cash), voucher ready', 'Ended unused'])
  })

  it('makes a spreadsheet of every voucher', () => {
    const lines = giftCsv([voucher, { ...voucher, recipient_name: 'Ann, "Annie"', status: 'ready', expired: true, booking: null }]).split('\r\n')
    expect(lines[0]).toBe('Code,Bank reference,Receipt,State,Gift,For,From,Buyer,Buyer email,Price,Paid by,Paid on,Valid until,Booked by,Session date,Booking reference,Used on,Ended on,Refunded on,Refund')
    expect(lines[1]).toBe('7K3M-QX9P,GIFT-ABCD2345,,Booked for 3 Jan,90 min,Sarah Jones,Tom,Tom Jones,tom@example.test,125.00,Bank transfer,2026-11-16,2027-11-16,Sarah Jones,2027-01-03,,2027-01-03,,,')
    expect(lines[2]).toContain('Ended unused,90 min,"Ann, ""Annie""",')
    const refunded = giftCsv([{ ...voucher, status: 'cancelled', booking: null, receipt_number: 'GV-2026-0001', refunded_at: '2026-11-20T10:00:00Z', refund_gbp: 50 }]).split('\r\n')[1]
    expect(refunded).toMatch(/^7K3M-QX9P,GIFT-ABCD2345,GV-2026-0001,Refunded £50,.*,2026-11-20,50\.00$/)
  })
  it('gives every voucher a plain status, and keeps refunded and cancelled ones in their own groups', () => {
    const base = { price_gbp: 90, paid_at: '2026-11-20T10:00:00Z' }
    expect(giftState({ ...base, status: 'ready' })).toEqual({ label: 'Ready', tone: 'ok' })
    expect(giftState({ ...base, status: 'used', booking: { date: '2026-12-14', status: 'confirmed', started: false } }).label).toBe('Booked for 14 Dec')
    expect(giftState({ ...base, status: 'used', booking: { date: '2026-12-14', status: 'completed', started: true } }).label).toBe('Used 14 Dec')
    expect(giftState({ ...base, status: 'used', booking: { date: '2026-12-14', status: 'cancelled', started: false } }).label).toBe('Used up (late cancel)')
    expect(giftState({ ...base, status: 'cancelled', refunded_at: '2026-11-25T10:00:00Z', refund_gbp: 45.5 }).label).toBe('Refunded £45.50')
    expect(giftState({ status: 'cancelled', paid_at: null }).label).toBe('Cancelled, not paid')
    const groups = giftGroups([{ ...base, status: 'cancelled', refunded_at: '2026-11-25T10:00:00Z', refund_gbp: 90 }, { status: 'cancelled', paid_at: null },
      { ...base, status: 'used', booking: { date: '2026-12-14', status: 'confirmed', started: false } }], Date.parse('2026-12-01T12:00:00Z'))
    expect([groups.refunded.length, groups.cancelled.length, groups.booked.length, groups.used.length]).toEqual([1, 1, 1, 0])
    expect(groups.refundedTotal).toBe(90)
  })
  it('shows the History the database kept, with who did each thing', () => {
    const steps = giftHistory({ ...voucher, history: [{ at: '2026-11-15T09:00:00Z', words: 'Bought online by Tom', actor: 'buyer' }, { at: '2026-11-16T10:00:00Z', words: 'Paid £125.00, bank transfer', actor: 'admin' }] })
    expect(steps.map(s => [s.text, s.who])).toEqual([['Bought online by Tom', 'Buyer'], ['Paid £125.00, bank transfer', 'You']])
  })
})
