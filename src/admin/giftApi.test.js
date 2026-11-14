import { describe, expect, it } from 'vitest'
import { createGiftAdminApi, giftGroups, NOT_SWITCHED_ON } from './giftApi.js'

const client = result => ({ rpc: async (name, args) => (typeof result === 'function' ? result(name, args) : result) })

describe('More › Gift vouchers', () => {
  it('groups the vouchers and counts what was sold in the last year', () => {
    const now = Date.parse('2026-12-01T12:00:00Z')
    const list = [
      { status: 'awaiting_payment', price_gbp: 90, paid_at: null },
      { status: 'ready', price_gbp: 125, paid_at: '2026-11-20T10:00:00Z' },
      { status: 'used', price_gbp: 180, paid_at: '2026-02-01T10:00:00Z' },
      { status: 'used', price_gbp: 90, paid_at: '2025-06-01T10:00:00Z' },
    ]
    const groups = giftGroups(list, now)
    expect([groups.waiting.length, groups.ready.length, groups.used.length]).toEqual([1, 1, 2])
    expect([groups.soldCount, groups.soldTotal]).toEqual([2, 305])
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
})
