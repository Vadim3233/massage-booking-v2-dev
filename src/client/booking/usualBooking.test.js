import { describe, expect, it } from 'vitest'
import { readUsual, rememberUsual, usualKey, usualLabel } from './usualBooking.js'

const catalogue = {
  areas: [{ id: 'a1', name: 'Chelsea' }, { id: 'a2', name: 'Fulham' }],
  services: [{ id: 's1', name: 'Massage' }],
  prices: [{ service_id: 's1', duration_minutes: 60 }, { service_id: 's1', duration_minutes: 90 }],
}
const memory = () => { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)) } }
const draft = { areaId: 'a1', serviceId: 's1', sessions: [{ duration_minutes: 90 }] }

describe('book your usual', () => {
  it('remembers the last booking and offers it back with names the client recognises', () => {
    const storage = memory()
    expect(rememberUsual(storage, draft)).toBe(true)
    const usual = readUsual(storage, catalogue)
    expect(usual).toEqual({ areaId: 'a1', serviceId: 's1', durations: [90], areaName: 'Chelsea', serviceName: 'Massage' })
    expect(usualLabel(usual)).toBe('Massage · 90 min · Chelsea')
    expect(usualLabel({ ...usual, durations: [60, 60] })).toBe('Massage · 60 min + 60 min · Chelsea')
  })
  it('offers nothing before a first booking, or after the saved text is damaged', () => {
    const storage = memory()
    expect(readUsual(storage, catalogue)).toBeNull()
    storage.setItem(usualKey, '{not json')
    expect(readUsual(storage, catalogue)).toBeNull()
    storage.setItem(usualKey, JSON.stringify({ version: 2, areaId: 'a1', serviceId: 's1', durations: [60] }))
    expect(readUsual(storage, catalogue)).toBeNull()
  })
  it('stops offering what can no longer be booked', () => {
    const storage = memory()
    rememberUsual(storage, draft)
    expect(readUsual(storage, { ...catalogue, areas: [{ id: 'a2', name: 'Fulham' }] })).toBeNull()
    expect(readUsual(storage, { ...catalogue, services: [] })).toBeNull()
    expect(readUsual(storage, { ...catalogue, prices: [{ service_id: 's1', duration_minutes: 60 }] })).toBeNull()
  })
  it('does not remember an unfinished draft, or fail when storage is full or blocked', () => {
    const storage = memory()
    expect(rememberUsual(storage, { ...draft, sessions: [] })).toBe(false)
    expect(rememberUsual(storage, { ...draft, areaId: '' })).toBe(false)
    expect(rememberUsual({ setItem() { throw new Error('quota') } }, draft)).toBe(false)
  })
})
