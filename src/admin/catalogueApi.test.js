import { describe, expect, it } from 'vitest'
import { parsePostcodes, parsePrice, priceText, slugify, validateArea, validateExtra, validateService } from './catalogueApi.js'

describe('prices as typed', () => {
  it('accepts pounds with up to two decimals', () => {
    expect(parsePrice('90')).toBe(90)
    expect(parsePrice('£90.50')).toBe(90.5)
    expect(parsePrice(' 0 ')).toBe(0)
    expect(parsePrice('12.5')).toBe(12.5)
  })
  it('refuses anything else, so a typing slip never becomes a price', () => {
    for (const bad of ['', 'abc', '-5', '9,50', '1.234', '100000', '1e3', '9 0']) expect(parsePrice(bad)).toBeNull()
  })
  it('shows a price with two decimals', () => {
    expect(priceText(90)).toBe('90.00')
    expect(priceText('12.5')).toBe('12.50')
    expect(priceText(null)).toBe('')
  })
})

describe('web-safe names', () => {
  it('makes a short, plain address-style name', () => {
    expect(slugify('Hot Stone Massage')).toBe('hot-stone-massage')
    expect(slugify("Shepherd’s Bush")).toBe('shepherd-s-bush')
    expect(slugify('Café  Crème!')).toBe('cafe-creme')
    expect(slugify('')).toBe('item')
    expect(slugify('x'.repeat(100)).length).toBe(60)
  })
})

describe('checking before saving', () => {
  const prices = (...offered) => [60, 90, 120].map(duration_minutes => ({ duration_minutes, offered: offered.includes(duration_minutes), price: offered.includes(duration_minutes) ? '90' : '' }))
  it('needs a name and a price for every length offered', () => {
    expect(validateService({ name: 'Massage', active: true }, prices(60, 90))).toBe('')
    expect(validateService({ name: ' ', active: true }, prices(60))).toBe('Give the treatment a name.')
    expect(validateService({ name: 'Massage', active: true }, [{ duration_minutes: 60, offered: true, price: 'free' }])).toBe('Enter a price for 60 minutes, for example 90 or 90.50.')
  })
  it('will not show a treatment that cannot be booked', () => {
    expect(validateService({ name: 'Massage', active: true }, prices())).toBe('A shown treatment needs at least one length with a price. Hide it instead, or offer a length.')
    expect(validateService({ name: 'Massage', active: false }, prices())).toBe('')
  })
  it('checks areas and extras', () => {
    expect(validateArea({ name: 'Chelsea', travel_surcharge_gbp: '0', congestion_fee_gbp: '18' })).toBe('')
    expect(validateArea({ name: '', travel_surcharge_gbp: '0', congestion_fee_gbp: '0' })).toBe('Give the area a name.')
    expect(validateArea({ name: 'Mayfair', travel_surcharge_gbp: '', congestion_fee_gbp: '0' })).toBe('Enter the travel surcharge, or 0 for none.')
    expect(validateExtra({ name: 'Extra strong', price_gbp: '15', duration_minutes: '0' })).toBe('')
    expect(validateExtra({ name: 'Extra strong', price_gbp: '15', duration_minutes: '-5' })).toBe('Extra time must be a whole number of minutes from 0 to 120.')
    expect(validateExtra({ name: 'Extra strong', price_gbp: '15', duration_minutes: '2.5' })).toBe('Extra time must be a whole number of minutes from 0 to 120.')
  })
})

describe('an area\'s postcodes', () => {
  it('reads them as typed: capitals, single spaces, no repeats', () => {
    expect(parsePostcodes('sw3, SW10 ,w2  1, sw3')).toEqual(['SW3', 'SW10', 'W2 1'])
    expect(parsePostcodes('')).toEqual([])
    expect(parsePostcodes(['SW3', 'W1'])).toEqual(['SW3', 'W1'])
  })
  it('refuses something that is not the start of a postcode', () => {
    const area = { name: 'Chelsea', travel_surcharge_gbp: '0', congestion_fee_gbp: '0' }
    expect(validateArea({ ...area, postcodes: 'SW3, W1K, W2 1' })).toBe('')
    expect(validateArea({ ...area, postcodes: 'SW3 4LP' })).toMatch(/"SW3 4LP" is not the start of a postcode/)
    expect(validateArea({ ...area, postcodes: 'Chelsea' })).toMatch(/"CHELSEA" is not/)
  })
})
