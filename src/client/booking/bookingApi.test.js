import { describe, expect, it } from 'vitest'
import { emptyDetails, newDraft } from './bookingDraft.js'
import { finalizeParams } from './bookingApi.js'

const draft = details => ({
  ...newDraft(), areaId: 'a1', serviceId: 's1', sessions: [{ duration_minutes: 60, recipient_name: '', preference_ids: [] }],
  hold: { hold_id: 'h1', hold_token: 't1' }, details: { ...emptyDetails, ...details },
})

describe('the request that makes a booking', () => {
  it('sends the address as one text, without the padding around it, and the four old boxes empty', () => {
    const params = finalizeParams(draft({ address: '  10 Test Street\nLondon SW1A 1AA \n', entry_instructions: ' Ring twice ' }), 'client-key', 'request-1')
    expect(params).toMatchObject({ p_address: '10 Test Street\nLondon SW1A 1AA', p_address_line_1: null, p_address_line_2: null, p_city: null, p_postcode: null, p_entry_instructions: 'Ring twice' })
  })
  it('sends no address text when a saved address is chosen, or when there is nothing but spaces', () => {
    expect(finalizeParams(draft({ savedAddressId: 'addr1', address: '' }), 'k', 'r')).toMatchObject({ p_saved_address_id: 'addr1', p_address: null })
    expect(finalizeParams(draft({ address: '   ' }), 'k', 'r')).toMatchObject({ p_saved_address_id: null, p_address: null })
  })
})
