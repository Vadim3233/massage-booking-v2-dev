import { describe, expect, it } from 'vitest'
import { amountRanges, emphasiseAmounts, telegramBoldEntities, whatsappBoldAmounts } from './moneyEmphasis.js'

describe('making the amount to pay stand out', () => {
  it('finds amounts as the app and the database write them', () => {
    const text = 'Pay £90.00, or £1,234.50 for both, or £90 now.'
    expect(amountRanges(text).map(({ start, end }) => text.slice(start, end))).toEqual(['£90.00', '£1,234.50', '£90'])
  })
  it('never makes an old price stand out', () => {
    expect(whatsappBoldAmounts('The price is now £180.00 (it was £150.00).')).toBe('The price is now *£180.00* (it was £150.00).')
    expect(whatsappBoldAmounts('Price £90 (was £120), £60 instead of £90, usually £100')).toBe('Price *£90* (was £120), *£60* instead of £90, usually £100')
  })
  it('leaves a comma or full stop after an amount outside it', () => {
    expect(whatsappBoldAmounts('now £180, using the reference. Total £5.')).toBe('now *£180*, using the reference. Total *£5*.')
  })
  it('changes nothing in a message with no amount', () => {
    expect(emphasiseAmounts('See you on Fri 28 Nov', a => `<b>${a}</b>`)).toBe('See you on Fri 28 Nov')
    expect(emphasiseAmounts(null, a => a)).toBe('')
  })
  it('gives Telegram bold entities, leaving out one cut off at the end', () => {
    const text = 'Pay £90.00 or £120.00'
    expect(telegramBoldEntities(text)).toEqual([{ type: 'bold', offset: 4, length: 6 }, { type: 'bold', offset: 14, length: 7 }])
    expect(telegramBoldEntities(text, 18)).toEqual([{ type: 'bold', offset: 4, length: 6 }])
  })
  it('counts positions the way Telegram does, after an emoji', () => {
    const text = '💷 To pay: £90.00'
    expect(telegramBoldEntities(text)[0]).toEqual({ type: 'bold', offset: 11, length: 6 })
  })
})
