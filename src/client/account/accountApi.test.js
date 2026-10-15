import { describe, expect, it } from 'vitest'
import { createAccountApi, friendlyError } from './accountApi.js'

describe('what a client is told when something goes wrong', () => {
  it('shows only messages written for clients and asks for a refresh when the situation changed', () => {
    const fee = friendlyError({ code: 'PT409', message: 'The late fee has changed. Please review it and confirm again.' })
    expect(fee.message).toBe('The late fee has changed. Please review it and confirm again.')
    expect(fee.refresh).toBe(true)
    const started = friendlyError({ code: '22023', message: 'This appointment has already started. Please contact Vad.' })
    expect(started.refresh).toBe(false)
  })
  it('keeps the date-limit message whatever number of days the Admin has set', () => {
    for (const days of [10, 40, 90]) expect(friendlyError({ code: '22023', message: `Online appointments can currently be arranged up to ${days} days ahead. Please choose another date.` }).message).toContain(`${days} days`)
    expect(friendlyError({ code: '22023', message: 'Online appointments can currently be arranged up to x days ahead.' }).message).toContain('Something went wrong')
  })
  it('hides anything technical', () => {
    const leaked = friendlyError({ code: 'XX000', message: 'duplicate key value violates unique constraint "bookings_pkey"' })
    expect(leaked.message).toBe('Something went wrong. Please try again, or contact Vad if it keeps happening.')
    expect(leaked.message).not.toMatch(/constraint|bookings|duplicate/)
  })
})

describe('what someone is told when a link or an account does not match the booking', () => {
  it('says one plain thing for a link that does not work', () => {
    expect(friendlyError({ code: '42501', message: 'This link is not valid or has expired. Please contact Vad.' }).message).toBe('This link is not valid or has expired. Please contact Vad.')
  })
  it('explains, in plain words, being signed in as someone else instead of "something went wrong"', () => {
    const text = friendlyError({ code: '42501', message: 'Booking is not available to this client' }).message
    expect(text).toContain('not on the account you are signed in to')
    expect(text).toContain('If you booked as a guest')
    expect(text).not.toMatch(/Something went wrong|client/)
  })
})

describe('the same five things from the private link in an email', () => {
  const link = { bookingId: 'b1', key: 'k'.repeat(64) }
  const make = (respond = () => ({ data: [], error: null })) => {
    const calls = []
    return { calls, api: createAccountApi({ rpc: async (name, args) => { calls.push([name, args]); return respond(name) } }, link) }
  }
  it('asks for the one booking with its code, and never for anything signed-in', async () => {
    const { calls, api } = make()
    await api.booking('b1')
    await api.terms('b1')
    expect(calls).toEqual([
      ['booking_by_key', { p_booking_id: 'b1', p_key: link.key }],
      ['change_terms_by_key', { p_booking_id: 'b1', p_key: link.key }],
    ])
  })
  it('sends the code with every time list, cancellation and move', async () => {
    const { calls, api } = make(name => ({ data: name === 'availability_by_key' ? [{ start_minutes: 600 }, { start_minutes: 630 }] : {}, error: null }))
    expect(await api.availability('b1', '2031-02-01')).toEqual([600, 630])
    await api.cancel('b1', 'r1', 85, ' Family emergency ')
    await api.reschedule('b1', 'r2', '2031-02-01', 720, 0)
    expect(calls).toEqual([
      ['availability_by_key', { p_booking_id: 'b1', p_key: link.key, p_date: '2031-02-01' }],
      ['cancel_by_key', { p_booking_id: 'b1', p_key: link.key, p_request_id: 'r1', p_acknowledged_fee: 85, p_reason: ' Family emergency ' }],
      ['reschedule_by_key', { p_booking_id: 'b1', p_key: link.key, p_request_id: 'r2', p_new_date: '2031-02-01', p_new_start_minutes: 720, p_acknowledged_fee: 0 }],
    ])
  })
  it('has no list of bookings, because that needs a sign-in', async () => {
    const { calls, api } = make()
    expect(await api.list()).toEqual([])
    expect(calls).toEqual([])
  })
  it('shows only the plain sentence when the link is refused, and hides anything technical', async () => {
    const refused = make(() => ({ data: null, error: { code: '42501', message: 'This link is not valid or has expired. Please contact Vad.' } }))
    await expect(refused.api.booking('b1')).rejects.toThrow('This link is not valid or has expired. Please contact Vad.')
    const broken = make(() => ({ data: null, error: { code: 'XX000', message: 'function public.booking_by_key does not exist' } }))
    await expect(broken.api.booking('b1')).rejects.toThrow('Something went wrong.')
    await expect(broken.api.cancel('b1', 'r', 0)).rejects.not.toThrow(/function|public/)
  })
})

describe('commands sent for a client', () => {
  it('send exactly the fee the client was shown', async () => {
    const calls = []
    const api = createAccountApi({ rpc: async (name, args) => { calls.push([name, args]); return { data: [], error: null } } })
    await api.cancel('b1', 'r1', 85, ' Family emergency ')
    expect(calls.at(-1)).toEqual(['client_cancel_booking', { p_booking_id: 'b1', p_request_id: 'r1', p_acknowledged_fee: 85, p_reason: ' Family emergency ' }])
    await api.reschedule('b1', 'r2', '2031-02-01', 720, 0)
    expect(calls.at(-1)).toEqual(['client_reschedule_booking', { p_booking_id: 'b1', p_request_id: 'r2', p_new_date: '2031-02-01', p_new_start_minutes: 720, p_acknowledged_fee: 0 }])
  })
})
