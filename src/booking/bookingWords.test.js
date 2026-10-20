import { describe, expect, it } from 'vitest'
import { bookingSentence, hoursWords, optionTotal, peopleChoices, peopleSentence, peopleShort, treatmentNoun } from './bookingWords.js'

const prices = [{ duration_minutes: 60, price_gbp: '90.00' }, { duration_minutes: 90, price_gbp: '125.00' }, { duration_minutes: 120, price_gbp: '170.00' }]

describe('a booking in words', () => {
  it('says how many people and how long, so 2 hours for 1 person cannot be read as 2 people', () => {
    expect(bookingSentence([120], 170)).toBe('One 2-hour massage for 1 person – £170.00')
    expect(bookingSentence([60, 60], 180)).toBe('Two 60-minute massages for 2 people, one after the other – 2 hours in total – £180.00')
    expect(bookingSentence([60, 60, 60], 270)).toBe('Three 60-minute massages for 3 people, one after the other – 3 hours in total – £270.00')
    expect(bookingSentence([60, 90], 215)).toBe('Two massages for 2 people, one after the other (60 min + 90 min) – 2 hours 30 minutes in total – £215.00')
    expect(peopleSentence([90], treatmentNoun('Soft Tissue Therapy'))).toBe('One 90-minute session for 1 person')
    expect(peopleSentence([])).toBe('')
    expect(hoursWords(90)).toBe('1 hour 30 minutes')
  })
  it('is short on the Admin\'s card', () => {
    expect(peopleShort([120])).toBe('1 person · 120 min')
    expect(peopleShort([60, 60, 60])).toBe('3 people · 3 × 60 min')
    expect(peopleShort([60, 90])).toBe('2 people · 60 + 90 min')
  })
  it('prices an option from the treatment\'s prices plus the area\'s travel and congestion fees', () => {
    expect(optionTotal(prices, { travel_surcharge_gbp: '0', congestion_fee_gbp: '0' }, [60, 60])).toBe(180)
    expect(optionTotal(prices, { travel_surcharge_gbp: '15.00', congestion_fee_gbp: '0' }, [120])).toBe(185)
    expect(optionTotal(prices, { travel_surcharge_gbp: '0', congestion_fee_gbp: '18.00' }, [60, 90])).toBe(233)
    expect(optionTotal(prices, null, [45])).toBeNull()
  })
  it('offers as many people as fit in a visit at the shortest length', () => {
    expect(peopleChoices(prices)).toEqual([1, 2, 3, 4])
    expect(peopleChoices([{ duration_minutes: 90 }, { duration_minutes: 120 }])).toEqual([1, 2])
    expect(peopleChoices([])).toEqual([])
  })
})
