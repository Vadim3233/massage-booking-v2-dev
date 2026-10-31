import { describe, expect, it, vi } from 'vitest'
import { emptyDetails, newDraft } from './bookingDraft.js'
import { createBookingApi, finalizeParams } from './bookingApi.js'

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

describe('the session a time is held with', () => {
  const client = session => ({ auth: {
    getSession: vi.fn(async () => ({ data: { session }, error: null })),
    signInAnonymously: vi.fn(async () => ({ data: {}, error: null })),
  } })
  it('starts a quiet guest session for a visitor who is not signed in', async () => {
    const visitor = client(null)
    await createBookingApi(visitor).ensureSession()
    expect(visitor.auth.signInAnonymously).toHaveBeenCalledTimes(1)
  })
  it('keeps the session of someone already signed in or already a guest', async () => {
    const signedIn = client({ user: { id: 'u1' } })
    await createBookingApi(signedIn).ensureSession()
    expect(signedIn.auth.signInAnonymously).not.toHaveBeenCalled()
  })
})

describe('saved addresses', () => {
  it('asks only for the signed-in client\'s own, even when row security would allow more (the Admin signed in on the booking page)', async () => {
    const calls = []
    const chain = { select: (...args) => { calls.push(['select', ...args]); return chain }, eq: (...args) => { calls.push(['eq', ...args]); return chain },
      order: () => Promise.resolve({ data: [], error: null }) }
    await createBookingApi({ from: (table) => { calls.push(['from', table]); return chain } }).addresses('client-1')
    expect(calls).toContainEqual(['eq', 'client_id', 'client-1'])
  })
})
