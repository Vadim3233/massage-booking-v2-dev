import { describe, expect, it } from 'vitest'
import { catalogueForOffer, offerCodeFromPath, offerFromRow } from './slotOffer.js'
import { finalizeParams } from './bookingApi.js'
import { newDraft, newSession } from './bookingDraft.js'
import { friendlyError } from './friendlyError.js'

const offer = { code: 'K7Q2MX', date: '2026-11-12', start: 1020, minutes: 60, price: 55, normal: 80, addTravelFee: false }

describe('a special-price offer link', () => {
  it('reads the code from the link, in any letter case', () => {
    expect(offerCodeFromPath('/offer/k7q2mx')).toBe('K7Q2MX')
    expect(offerCodeFromPath('/offer/K7Q2MX/')).toBe('K7Q2MX')
    expect(offerCodeFromPath('/')).toBe(null)
    expect(offerCodeFromPath('/offer/')).toBe(null)
    expect(offerCodeFromPath('/offer/K7Q2MX/extra')).toBe(null)
  })

  it('keeps what the database says the offer is', () => {
    expect(offerFromRow('K7Q2MX', { state: 'open', date: '2026-11-12', start_minutes: 1020, duration_minutes: 60, price_gbp: '55.00', normal_price_gbp: '80.00' })).toEqual(offer)
    expect(offerFromRow('K7Q2MX', { date: '2026-11-12', start_minutes: 1020, duration_minutes: 60, price_gbp: '55.00', normal_price_gbp: null }).normal).toBe(null)
  })

  it('narrows the catalogue to the offer: its length, its price, no extras, no fees shown', () => {
    const catalogue = {
      areas: [{ id: 'a', name: 'Chelsea', travel_surcharge_gbp: 20, congestion_fee_gbp: 15, minimum_booking_minutes: 90 }],
      services: [{ id: 's1', name: 'Deep tissue' }, { id: 's2', name: 'Long only' }],
      prices: [{ service_id: 's1', duration_minutes: 60, price_gbp: '80' }, { service_id: 's1', duration_minutes: 90, price_gbp: '110' }, { service_id: 's2', duration_minutes: 90, price_gbp: '110' }],
      enhancements: [{ id: 'e', name: 'Hot stones' }],
    }
    const narrowed = catalogueForOffer(catalogue, offer)
    expect(narrowed.services.map(service => service.id)).toEqual(['s1'])
    expect(narrowed.prices).toEqual([{ service_id: 's1', duration_minutes: 60, price_gbp: 55 }])
    expect(narrowed.enhancements).toEqual([])
    expect(narrowed.areas[0]).toMatchObject({ travel_surcharge_gbp: 0, congestion_fee_gbp: 0, minimum_booking_minutes: null })
    const withFee = catalogueForOffer(catalogue, { ...offer, addTravelFee: true })
    expect(withFee.areas[0].travel_surcharge_gbp).toBe(catalogue.areas[0].travel_surcharge_gbp)
    expect(withFee.areas[0].minimum_booking_minutes).toBe(null)
    expect(offerFromRow('K7Q2MX', { date: '2026-11-12', start_minutes: 1020, duration_minutes: 60, price_gbp: '55.00', normal_price_gbp: '80.00', add_travel_fee: true }).addTravelFee).toBe(true)
    expect(catalogueForOffer(catalogue, null)).toBe(catalogue)
  })

  it('sends the code with the booking, and nothing new for a usual booking', () => {
    const draft = { ...newDraft(), areaId: 'a', serviceId: 's1', sessions: [newSession(60)], hold: { hold_id: 'h', hold_token: 't' }, details: { ...newDraft().details, address: '1 Road' } }
    expect(finalizeParams({ ...draft, offer }, 'key', 'request').p_offer_code).toBe('K7Q2MX')
    expect('p_offer_code' in finalizeParams(draft, 'key', 'request')).toBe(false)
  })

  it('shows the database\'s own words when the special time has gone', () => {
    expect(friendlyError({ message: 'Sorry, this special time is no longer available.', code: '23P01' })).toBe('Sorry, this special time is no longer available.')
    expect(friendlyError({ message: 'Time slot is no longer available', code: '23P01' })).toMatch(/^Sorry, that time has just been taken/)
  })
})
