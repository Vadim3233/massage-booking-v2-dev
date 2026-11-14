import { describe, expect, it } from 'vitest'
import { codeFromPath, codeShown, designsInOrder, giftChoices, giftWords, kicker, occasionsInOrder, travelChoice, travelPart, whatsappText, whole, withLove } from './giftWords.js'

const options = { all_areas_cover: 35, areas: [{ id: 'c', name: 'Chelsea', travel: 20, congestion: 15 }, { id: 'n', name: 'Nearby', travel: 0, congestion: 0 }] }

describe('gift words', () => {
  it('reads the code from the link, with or without the dash, in any case', () => {
    expect(codeFromPath('/gift/7K3M-QX9P')).toBe('7K3MQX9P')
    expect(codeFromPath('/gift/7k3mqx9p/')).toBe('7K3MQX9P')
    expect(codeFromPath('/gift')).toBeNull()
    expect(codeFromPath('/gift/short')).toBeNull()
    expect(codeShown('7K3MQX9P')).toBe('7K3M-QX9P')
  })
  it('names the gift', () => {
    expect(giftWords(60)).toBe('A 60-minute massage')
    expect(giftWords(120)).toBe('A 2-hour massage')
    expect(giftWords(60, 2)).toBe('A 60-minute massage for two')
  })
  it('offers each length for one, and the shortest for two at twice the price', () => {
    const list = giftChoices([{ minutes: 60, price: 90 }, { minutes: 90, price: 125 }, { minutes: 120, price: 170 }])
    expect(list.map(item => [item.title, item.price])).toEqual([['60-minute massage', 90], ['90-minute massage', 125], ['2-hour massage', 170], ['Massage for two', 180]])
    expect(list.filter(item => item.loved).map(item => item.minutes)).toEqual([90])
  })
  it('adds the travel part the buyer chose', () => {
    expect(travelPart(options, { area: 'unsure', cover: 'all' })).toBe(35)
    expect(travelPart(options, { area: 'unsure', cover: 'none' })).toBe(0)
    expect(travelPart(options, { area: 'c', cover: 'all' })).toBe(35)
    expect(travelPart(options, { area: 'n', cover: 'all' })).toBe(0)
    expect([travelChoice({ area: 'unsure', cover: 'all' }), travelChoice({ area: 'unsure', cover: 'none' }), travelChoice({ area: 'c' })]).toEqual(['all', 'none', 'area'])
  })
  it('puts Christmas first in November and December, and last the rest of the year', () => {
    expect(designsInOrder(new Date('2026-11-20'))[0].id).toBe('christmas_night')
    expect(designsInOrder(new Date('2027-03-01'))[0].id).toBe('any_occasion')
    expect(occasionsInOrder(new Date('2026-12-01'))[0].name).toBe('Christmas')
    expect(occasionsInOrder(new Date('2027-05-01'))[0].name).toBe('For Mum')
  })
  it('signs the message, and words the voucher for the occasion', () => {
    expect(withLove('Happy birthday!', ' Anna ')).toBe('Happy birthday! Love, Anna x')
    expect(kicker('christmas_night', 'Happy Christmas!')).toBe('A Christmas gift for')
    expect(kicker('christmas_night', 'Happy birthday!')).toBe('A little gift of calm for')
    expect(kicker('gold_foil', '')).toBe('A special gift for')
  })
  it('writes the WhatsApp message and the prices plainly', () => {
    expect(whatsappText({ from_name: 'Anna', minutes: 60, people: 1, code: '7K3MQX9P' }, 'https://x.test')).toBe('Anna has sent you a gift: a 60-minute massage at your home 🎁\n\nOpen it here: https://x.test/gift/7K3M-QX9P')
    expect(whole(125)).toBe('£125')
    expect(whole(12.5)).toBe('£12.50')
  })
})
