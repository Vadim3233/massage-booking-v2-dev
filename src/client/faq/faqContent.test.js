import { describe, expect, it } from 'vitest'
import { clientFaq, listWords } from './faqContent.js'

const rules = { horizonDays: 60, noticeHours: 2, freeHours: 24, graceMinutes: 60 }
const find = (sections, question) => sections.flatMap(section => section.items).find(item => item.q === question)

describe('client FAQ', () => {
  it('takes its numbers from the booking rules', () => {
    const faq = clientFaq({ rules })
    expect(find(faq, 'How far ahead can I book, and how late?').a[0]).toBe('Up to 60 days ahead, and at least 2 hours before the start time.')
    expect(find(faq, 'Is there a fee for changing or cancelling?').a[0]).toBe("It's free to change or cancel more than 24 hours before your appointment. If you change your mind within 1 hour of booking, that's free too.")
  })

  it('says there is no fee when free cancellation lasts until the start', () => {
    const faq = clientFaq({ rules: { ...rules, freeHours: 0 } })
    expect(find(faq, 'Is there a fee for changing or cancelling?').a).toEqual(['You can change or cancel at no charge any time before your appointment begins.'])
  })

  it('lists the areas, their fees and their minimum lengths', () => {
    const areas = [
      { name: 'Chelsea', travel_surcharge_gbp: 0, congestion_fee_gbp: 0, minimum_booking_minutes: null },
      { name: 'Mayfair', travel_surcharge_gbp: 0, congestion_fee_gbp: 18, minimum_booking_minutes: 120 },
      { name: 'Marylebone', travel_surcharge_gbp: 10.5, congestion_fee_gbp: 0, minimum_booking_minutes: 90 },
    ]
    const faq = clientFaq({ rules, areas })
    expect(find(faq, 'Where do you work?').a[0]).toBe('Selected parts of Chelsea, Mayfair and Marylebone.')
    expect(find(faq, 'Is there a travel fee or congestion charge?').list).toEqual(['Mayfair: £18 congestion charge', 'Marylebone: £10.50 travel fee'])
    expect(find(faq, 'Is there a minimum booking length?').list).toEqual(['Mayfair: at least 2 hours in total', 'Marylebone: at least 90 minutes in total'])
  })

  it('leaves out the minimum length question when no area has one', () => {
    expect(find(clientFaq({ rules, areas: [{ name: 'Chelsea' }] }), 'Is there a minimum booking length?')).toBeUndefined()
  })

  it('joins names in plain English', () => {
    expect(listWords(['A'])).toBe('A')
    expect(listWords(['A', 'B'])).toBe('A and B')
  })
})
