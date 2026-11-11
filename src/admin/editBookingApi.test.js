import { describe, expect, it, vi } from 'vitest'
import { createEditBookingApi, editFailure } from './editBookingApi.js'

describe('editing a booking from the Admin', () => {
  it('sends the people, the time and the choices to the database', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null })
    const api = createEditBookingApi({ rpc })
    const people = [{ id: 's1', service_id: 'swed', duration_minutes: '90', recipient_name: ' Ana ' }]
    await api.save({ id: 'b1', updated_at: 't' }, 'r1', { people, slot: { date: '2026-12-01', start: 600, anyTime: true }, notify: false, lowerPrice: true })
    expect(rpc).toHaveBeenCalledWith('admin_edit_booking', { p_booking_id: 'b1', p_request_id: 'r1', p_booking_updated_at: 't',
      p_sessions: [{ id: 's1', service_id: 'swed', duration_minutes: 90, recipient_name: 'Ana' }], p_new_date: '2026-12-01', p_new_start_minutes: 600,
      p_any_time: true, p_notify_client: false, p_lower_price: true })
    await api.save({ id: 'b1', updated_at: 't' }, 'r2', { people, slot: null })
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_new_date: null, p_new_start_minutes: null, p_any_time: false, p_notify_client: true, p_lower_price: false })
  })
  it('shows the database\'s own sentences and nothing technical', () => {
    expect(editFailure({ message: 'Nothing has changed.' }).message).toBe('Nothing has changed.')
    expect(editFailure({ message: 'That treatment is not offered for 120 minutes. Choose another length or treatment.' }).message).toMatch(/^That treatment/)
    expect(editFailure({ message: 'relation "x" does not exist' }).message).toBe('Could not save the change. Please check your connection and try again.')
    expect(editFailure({ message: 'Booking state changed', code: 'PT409' })).toMatchObject({ conflict: true })
  })
})
