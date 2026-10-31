import { supabase } from '../lib/supabase.js'
import { areaForPostcode, areasHavePostcodes, tidyAddress } from '../lib/address.js'

// Changing the address of a booking still to come. The area follows the postcode when the areas have postcodes (the Admin can still pick another);
// another area brings its own travel and congestion fees, so the total is shown before saving. The same area keeps the fees it was booked with.
// A client with "No travel fee" pays no travel fee in the new area either.
export const ADDRESS_EDITABLE = ['awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed']

export function addressPreview(booking, areas, form) {
  const area = areas.find(item => item.id === form.areaId)
  const suggested = areasHavePostcodes(areas) ? areaForPostcode(areas.filter(item => item.active), form.address) : null
  const sameArea = form.areaId === booking.service_area_id
  const total = !area || sameArea ? Number(booking.total_gbp)
    : Number(booking.service_subtotal_gbp) + Number(booking.enhancements_total_gbp) + (booking.clients?.no_travel_fee ? 0 : Number(area.travel_surcharge_gbp)) + Number(area.congestion_fee_gbp)
  const paid = !['awaiting_transfer', 'awaiting_approval', 'approved'].includes(booking.booking_payments?.status)
  const priceChanges = total !== Number(booking.total_gbp)
  const problem = !tidyAddress(form.address) ? 'Write the address.'
    : priceChanges && paid ? 'The client has already paid or sent the money, so the area cannot change to one with other fees.' : ''
  return { area, suggested, total, priceChanges, problem }
}

export function createBookingAddressApi(client) {
  return {
    async change(booking, requestId, form) {
      const { error } = await client.rpc('admin_change_booking_address', {
        p_booking_id: booking.id, p_request_id: requestId, p_booking_updated_at: booking.updated_at,
        p_address: form.address, p_entry_instructions: form.entry || null, p_service_area_id: form.areaId,
      })
      if (!error) return
      if (['PT409', '40001'].includes(error.code)) throw new Error('This booking changed before you could finish. Close it, open it again and try once more.')
      throw new Error(error.code === '22023' ? error.message : 'Could not change the address. Please check your connection and try again.')
    },
  }
}
export const bookingAddressApi = createBookingAddressApi(supabase)
