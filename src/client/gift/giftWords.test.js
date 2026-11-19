import { describe, expect, it } from 'vitest'
import { areaGroups, codeFromPath, codeShown, designsInOrder, fromLine, giftChoices, giftWords, kicker, occasionsInOrder, renameSignOff, shopLink, shopMessage, travelTiers, travelWords, whatsappText, whole, withLove } from './giftWords.js'

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
  it('turns the areas into a few one-tap cards: free, each lower charge, and everything', () => {
    const live = { all_areas_cover: 20, areas: [{ name: 'Chelsea', travel: 0, congestion: 0 }, { name: 'Mayfair', travel: 0, congestion: 18 }, { name: 'Westminster', travel: 0, congestion: 18 },
      { name: 'Clapham', travel: 20, congestion: 0 }, { name: 'Fulham', travel: '0.00', congestion: '0.00' }] }
    const tiers = travelTiers(live)
    expect(tiers.map(t => [t.key, t.choice, t.cover, t.title])).toEqual([['none', 'none', 0, 'Just the massage'], ['upto-18', 'upto', 18, 'Congestion charge included'],
      ['all', 'all', 20, 'Everything included']])
    expect(tiers[0].names).toEqual(['Chelsea', 'Fulham'])
    expect(tiers[1].or).toBe('Mayfair or Westminster')
    expect(tiers[2].charged.map(g => g.label)).toEqual(['Congestion charge £18', 'Travel fee £20'])
    expect(travelTiers({ all_areas_cover: 0, areas: [{ name: 'Chelsea', travel: 0, congestion: 0 }] }).map(t => t.key)).toEqual(['none'])
    expect(travelTiers(options).map(t => t.key)).toEqual(['none', 'all'])
  })
  it('says what a voucher covers besides the massage', () => {
    expect(travelWords({ travel_choice: 'all' })).toBe('Travel and congestion included, anywhere in my areas')
    expect(travelWords({ travel_choice: 'upto', travel_cover: 18 })).toBe('Travel and congestion included up to £18')
    expect(travelWords({ travel_choice: 'area', area_name: 'Clapham' })).toBe('Travel to Clapham included')
    expect(travelWords({ travel_choice: 'none' })).toBe('')
  })
  it('puts Navy and gold first, then Christmas in November and December, and Christmas last the rest of the year', () => {
    expect(designsInOrder(new Date('2026-11-20')).map(d => d.id)).toEqual(['navy_gold', 'christmas_night', 'wrapped_present', 'gold_foil', 'black_gold', 'any_occasion'])
    expect(designsInOrder(new Date('2027-03-01')).map(d => d.id)).toEqual(['navy_gold', 'any_occasion', 'christmas_night', 'wrapped_present', 'gold_foil', 'black_gold'])
    expect(kicker('navy_gold', 'Merry Christmas')).toBe('A gift of wellness for')
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

  it('invites someone to buy a voucher, by first name, with Christmas wording in November and December', () => {
    const link = shopLink('https://booking.vadmassage.com')
    expect(link).toBe('https://booking.vadmassage.com/gift')
    const christmas = shopMessage(link, ' Sarah ', new Date('2026-12-01T12:00:00Z'))
    expect(christmas.startsWith('Hi Sarah! Looking for a Christmas present?')).toBe(true)
    expect(christmas).toContain('\nhttps://booking.vadmassage.com/gift\n')
    expect(christmas.endsWith('Warm wishes,\nVadim')).toBe(true)
    expect(shopMessage(link, '', new Date('2026-05-01T12:00:00Z')).startsWith('Hi! Looking for a present for someone special?')).toBe(true)
  })

  it('groups the areas by what they add, no charge first', () => {
    const groups = areaGroups([{ name: 'Chelsea', travel: '0.00', congestion: '0.00' }, { name: 'Clapham', travel: 20, congestion: 0 }, { name: 'Mayfair', travel: 0, congestion: 18 },
      { name: 'Fulham', travel: 0, congestion: 0 }, { name: 'Westminster', travel: 0, congestion: 18 }])
    expect(groups).toEqual([{ label: 'No extra charge', extra: 0, names: ['Chelsea', 'Fulham'] }, { label: 'Congestion charge £18', extra: 18, names: ['Mayfair', 'Westminster'] },
      { label: 'Travel fee £20', extra: 20, names: ['Clapham'] }])
  })
})

describe('sender on the voucher', () => {
  it('adds "From <name>" only when the message does not already name the sender', () => {
    expect(fromLine('Anna', 'Happy birthday! Love, Anna x')).toBe('')
    expect(fromLine('Anna', 'Happy birthday, enjoy it!')).toBe('From Anna')
    expect(fromLine('  Anna ', '')).toBe('From Anna')
    expect(fromLine('', 'Happy birthday!')).toBe('')
    expect(fromLine('anna', 'Love, ANNA x')).toBe('')
  })
  it('keeps "Love, <name> x" in step when the name is typed after the message was edited', () => {
    expect(renameSignOff('Enjoy it, Mum! Love, … x', '', 'Anna')).toBe('Enjoy it, Mum! Love, Anna x')
    expect(renameSignOff('Enjoy! Love, Ann x', 'Ann', 'Anna')).toBe('Enjoy! Love, Anna x')
    expect(renameSignOff('Enjoy! Love, Anna x', 'Anna', '')).toBe('Enjoy! Love, … x')
    expect(renameSignOff('My own words, from me', 'Ann', 'Anna')).toBe('My own words, from me')
  })
})
