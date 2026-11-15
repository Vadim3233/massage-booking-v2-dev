import { describe, expect, it } from 'vitest'
import { cleanGiftCode, giftCodeFromSearch, giftFromRow, giftLines, giftSessions } from './giftCode.js'

describe('booking with a gift voucher', () => {
  it('reads the code from the link, however it was written', () => {
    expect(giftCodeFromSearch('?gift=7K3M-QX9P')).toBe('7K3MQX9P')
    expect(giftCodeFromSearch('?gift=7k3m%20qx9p&x=1')).toBe('7K3MQX9P')
    expect(giftCodeFromSearch('?gift=nope')).toBeNull()
    expect(giftCodeFromSearch('')).toBeNull()
    expect(cleanGiftCode(' 7k3m-qx9p ')).toBe('7K3MQX9P')
  })
  it('keeps what the voucher gives and makes its sessions', () => {
    const gift = giftFromRow('7K3MQX9P', { minutes: 60, people: 2, from_name: 'Jo', recipient_name: 'Sam', travel_choice: 'none', travel_cover: '0' })
    expect(gift).toMatchObject({ code: '7K3MQX9P', minutes: 60, people: 2, from: 'Jo', travel: 'none', cover: 0 })
    expect(giftSessions(gift, minutes => ({ duration_minutes: minutes }))).toEqual([{ duration_minutes: 60 }, { duration_minutes: 60 }])
  })
  it('reads what the voucher pays from the quote', () => {
    expect(giftLines({ total_gbp: 160, gift_covered_gbp: '125.00', to_pay_gbp: '35.00' })).toEqual({ covered: 125, toPay: 35 })
    expect(giftLines({ total_gbp: 90 })).toBeNull()
  })
})
