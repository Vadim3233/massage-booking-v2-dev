import { describe, expect, it } from 'vitest'
import { addressPreview } from './bookingAddressApi.js'

const chelsea = { id: 'c', name: 'Chelsea', active: true, travel_surcharge_gbp: 0, congestion_fee_gbp: 0, postcodes: ['SW3'] }
const mayfair = { id: 'm', name: 'Mayfair', active: true, travel_surcharge_gbp: 0, congestion_fee_gbp: 18, postcodes: ['W1'] }
const booking = (payment = 'awaiting_transfer') => ({ service_area_id: 'c', total_gbp: 90, service_subtotal_gbp: 90, enhancements_total_gbp: 0, booking_payments: { status: payment } })

describe('changing a booking\'s address', () => {
  it('suggests the area the postcode is in', () => {
    expect(addressPreview(booking(), [chelsea, mayfair], { address: '1 Park Lane, W1K 1PN', areaId: 'c' }).suggested).toBe(mayfair)
  })
  it('works out the new total for another area', () => {
    const preview = addressPreview(booking(), [chelsea, mayfair], { address: '1 Park Lane, W1K 1PN', areaId: 'm' })
    expect(preview.total).toBe(108)
    expect(preview.priceChanges).toBe(true)
    expect(preview.problem).toBe('')
  })
  it('keeps the price in the same area', () => {
    expect(addressPreview(booking('paid'), [chelsea, mayfair], { address: '7 Cheyne Walk, SW3 5LR', areaId: 'c' })).toMatchObject({ total: 90, priceChanges: false, problem: '' })
  })
  it('will not change the price once the client has paid', () => {
    expect(addressPreview(booking('paid'), [chelsea, mayfair], { address: '1 Park Lane, W1K 1PN', areaId: 'm' }).problem).toMatch(/already paid/)
    expect(addressPreview(booking(), [chelsea, mayfair], { address: '  ', areaId: 'c' }).problem).toBe('Write the address.')
  })
})
