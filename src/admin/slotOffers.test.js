import { describe, expect, it } from 'vitest'
import { bestStart, canOffer, isUsualPrice, roomAround, travelUsed, closingChoices, lengthsThatFit, londonInstant, offerDay, offerMessage, startsThatFit, withOffers } from './slotOffers.js'

const offer = { id: 'o1', code: 'K7Q2MX', date: '2026-11-12', start_minutes: 1020, duration_minutes: 60, price_gbp: '55.00', normal_price_gbp: '80.00', closes_at: '2026-11-12T16:00:00Z' }

describe('special-price offers (Admin)', () => {
  it('finds the London moment either side of the clocks changing', () => {
    expect(londonInstant('2026-11-12', 1020).toISOString()).toBe('2026-11-12T17:00:00.000Z')
    expect(londonInstant('2026-07-01', 1020).toISOString()).toBe('2026-07-01T16:00:00.000Z')
  })

  it('names the day the way a person says it', () => {
    expect(offerDay('2026-11-12', '2026-11-12')).toBe('today, Thursday 12 November')
    expect(offerDay('2026-11-13', '2026-11-12')).toBe('tomorrow, Friday 13 November')
    expect(offerDay('2026-11-14', '2026-11-12')).toBe('on Saturday 14 November')
  })

  it('writes the WhatsApp message with the link and the usual price crossed out in words', () => {
    expect(offerMessage(offer, '2026-11-12', 'https://book.example')).toBe(
      "Hi! I've just had a time free up today, Thursday 12 November, 17:00 to 18:00.\n\n" +
      'A 60-minute massage at your home for £55 instead of £80. First to book gets it:\nhttps://book.example/offer/K7Q2MX\n\nWarm wishes,\nVadim')
  })

  it('writes a friendly "one time left" message at the usual price', () => {
    const usual = { ...offer, date: '2026-11-15', price_gbp: '80', normal_price_gbp: '80' }
    expect(isUsualPrice(usual)).toBe(true)
    expect(isUsualPrice(offer)).toBe(false)
    expect(offerMessage(usual, '2026-11-12', 'https://book.example')).toBe(
      'Hi! I have one time left on Sunday 15 November, 17:00 to 18:00.\n\n' +
      'A 60-minute massage at your home for £80. Would you like it? You can book it here:\nhttps://book.example/offer/K7Q2MX\n\nWarm wishes,\nVadim')
  })

  it('leaves out "instead of" when the price is not lower', () => {
    expect(offerMessage({ ...offer, price_gbp: '80', normal_price_gbp: '80' }, '2026-11-12', 'https://b')).not.toMatch(/instead of/)
    expect(offerMessage({ ...offer, price_gbp: '57.50', normal_price_gbp: null }, '2026-11-12', 'https://b')).toMatch(/for £57.50\. First/)
  })

  it('offers closing times still to come, one hour before first', () => {
    const at15 = Date.parse('2026-11-12T15:00:00Z')
    const choices = closingChoices('2026-11-12', 1020, at15)
    expect(choices.map(choice => choice.label)).toEqual(['1 hour before (16:00)', '30 minutes before (16:30)', 'When it starts (17:00)'])
    expect(choices[0].at.toISOString()).toBe('2026-11-12T16:00:00.000Z')
    expect(closingChoices('2026-11-12', 1020, Date.parse('2026-11-12T16:59:00Z')).map(choice => choice.minutes)).toEqual([0])
    expect(closingChoices('2026-11-12', 1020, Date.parse('2026-11-12T17:00:00Z'))).toEqual([])
  })

  it('works out which lengths and starts fit a free stretch', () => {
    expect(lengthsThatFit({ start: 1020, end: 1080 }, [60, 90, 120])).toEqual([60])
    expect(startsThatFit({ start: 960, end: 1080 }, 60)).toEqual([960, 990, 1020])
    expect(startsThatFit({ start: 960, end: 1080 }, 60, 1000)).toEqual([1020])
    expect(startsThatFit({ start: 1020, end: 1080 }, 90)).toEqual([])
  })

  it('only offers free time still to come', () => {
    expect(canOffer('2026-11-12', { start: 1020, end: 1080 }, '2026-11-12', 1000)).toBe(true)
    expect(canOffer('2026-11-12', { start: 1020, end: 1080 }, '2026-11-12', 1060)).toBe(false)
    expect(canOffer('2026-11-11', { start: 1020, end: 1080 }, '2026-11-12', 0)).toBe(false)
    expect(canOffer('2026-11-13', { start: 1020, end: 1080 }, '2026-11-12', 1439)).toBe(true)
  })

  it('puts an open offer in place of the free time it takes', () => {
    const rows = [
      { kind: 'booking', id: 'b', start: 900, end: 990 },
      { kind: 'free', id: 'free-960', start: 960, end: 1080 },
      { kind: 'buffer', id: 'x', start: 1080, end: 1140 },
    ]
    expect(withOffers(rows, [offer]).map(row => [row.kind, row.start, row.end])).toEqual([
      ['booking', 900, 990], ['free', 960, 1020], ['offer', 1020, 1080], ['buffer', 1080, 1140],
    ])
    expect(withOffers(rows, [])).toBe(rows)
  })

  it('lets an offer use the travel time either side of a short free stretch (Vadim, 12 Nov: 17:30-18:00 free, offer 17:00-18:00)', () => {
    const rows = [
      { kind: 'booking', id: 'a', start: 930, end: 990 },
      { kind: 'buffer', id: 'b1', start: 990, end: 1050 },
      { kind: 'free', id: 'free-1050', start: 1050, end: 1080 },
      { kind: 'buffer', id: 'b2', start: 1080, end: 1140 },
      { kind: 'booking', id: 'c', start: 1140, end: 1200 },
    ]
    const room = roomAround(rows, rows[2])
    expect(room).toEqual({ start: 990, end: 1140, free: { start: 1050, end: 1080 } })
    expect(lengthsThatFit(room, [60, 90, 120, 180])).toEqual([60, 90, 120])
    expect(bestStart(room, 60)).toBe(1020)
    expect(travelUsed(room, 1020, 60)).toBe(30)
    expect(travelUsed(room, 990, 150)).toBe(120)
    expect(bestStart(room, 60, 1060)).toBe(1080)
    expect(roomAround([{ kind: 'free', id: 'f', start: 600, end: 720 }], { kind: 'free', id: 'f', start: 600, end: 720 })).toEqual({ start: 600, end: 720, free: { start: 600, end: 720 } })
  })

  it('takes an offer out of the travel time it uses too', () => {
    const rows = [
      { kind: 'buffer', id: 'b1', start: 990, end: 1050 },
      { kind: 'free', id: 'free-1050', start: 1050, end: 1080 },
      { kind: 'buffer', id: 'b2', start: 1080, end: 1140 },
    ]
    expect(withOffers(rows, [offer]).map(row => [row.kind, row.start, row.end])).toEqual([
      ['buffer', 990, 1020], ['offer', 1020, 1080], ['buffer', 1080, 1140],
    ])
  })
})
