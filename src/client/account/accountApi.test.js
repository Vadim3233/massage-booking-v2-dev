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
