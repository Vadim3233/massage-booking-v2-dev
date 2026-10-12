import { describe, expect, it } from 'vitest'
import { defaultsFromLast } from './presentation.js'

const catalogue = {
  services: [{ id: 's-massage', name: 'Massage' }, { id: 's-stretch', name: 'Assisted Stretching' }],
  areas: [{ id: 'a-chelsea', name: 'Chelsea' }, { id: 'a-fulham', name: 'Fulham' }],
  prices: [
    { service_id: 's-massage', duration_minutes: 60 }, { service_id: 's-massage', duration_minutes: 90 },
    { service_id: 's-stretch', duration_minutes: 60 },
  ],
}
const empty = (overrides = {}) => ({ serviceId: '', areaId: '', payment: 'bank_pending', start: null, sessions: [{ duration_minutes: 60, recipient_name: 'Amelia', preference_ids: [] }], ...overrides })
const last = (overrides = {}) => ({ service_area_id: 'a-fulham', booking_sessions: [{ position: 1, service_id: 's-massage', duration_minutes: 90 }], booking_payments: { method: 'cash' }, ...overrides })

describe('what a regular client usually books', () => {
  it('fills the treatment, length, area and payment from the last booking', () => {
    expect(defaultsFromLast(empty(), catalogue, last())).toEqual({
      serviceId: 's-massage', areaId: 'a-fulham', payment: 'cash_appointment',
      sessions: [{ duration_minutes: 90, recipient_name: 'Amelia', preference_ids: [] }],
    })
  })
  it('suggests Massage for a client with no history', () => {
    expect(defaultsFromLast(empty(), catalogue, null)).toEqual({ serviceId: 's-massage' })
  })
  it('never overwrites something already chosen', () => {
    const chosen = empty({ serviceId: 's-stretch', areaId: 'a-chelsea', payment: 'bank_received', start: 840 })
    expect(defaultsFromLast(chosen, catalogue, last())).toEqual({})
  })
  it('ignores a length, area or treatment that no longer exists', () => {
    const stale = last({ service_area_id: 'gone', booking_sessions: [{ position: 1, service_id: 'gone', duration_minutes: 120 }] })
    expect(defaultsFromLast(empty(), catalogue, stale)).toEqual({ serviceId: 's-massage', payment: 'cash_appointment' })
  })
  it('keeps several people as they are rather than guessing', () => {
    const group = empty({ sessions: [{ duration_minutes: 60, recipient_name: 'A' }, { duration_minutes: 60, recipient_name: 'B' }] })
    expect(defaultsFromLast(group, catalogue, last())).not.toHaveProperty('sessions')
  })
  it('uses the first session when the last booking had several', () => {
    const many = last({ booking_sessions: [{ position: 2, service_id: 's-stretch', duration_minutes: 60 }, { position: 1, service_id: 's-massage', duration_minutes: 90 }] })
    expect(defaultsFromLast(empty(), catalogue, many).serviceId).toBe('s-massage')
  })
})
