import { describe, expect, it } from 'vitest'
import { quickPlan } from './quickHours.js'

// A day as the grid sees it: 48 half hours, open from `from` to `to`, with extras laid over.
const day = (from, to, extra = {}) => Array.from({ length: 48 }, (_, index) => {
  const start_minutes = index * 30
  return { start_minutes, open: from != null && start_minutes >= from && start_minutes < to, locked: null, label: null, booking_id: null, held: false, ...(extra[start_minutes] || {}) }
})

describe('quick hours', () => {
  it('opens exactly the hours picked', () => {
    const plan = quickPlan(day(870, 1110), 840, 1200)
    expect(plan.result).toEqual({ from: 840, to: 1200 })
    expect(plan.open).toHaveLength(12)
    expect(plan.note).toBe('')
  })
  it('a day off becomes a working day', () => expect(quickPlan(day(null, null), 600, 720).open).toEqual([600, 630, 660, 690]))
  it('a break already inside the hours stays', () => {
    const plan = quickPlan(day(600, 1080, { 720: { open: false }, 750: { open: false } }), 600, 1200)
    expect(plan.open).not.toContain(720)
    expect(plan.open).toContain(1140)
  })
  it('a booking outside the new hours keeps them open and says so', () => {
    const booked = { 1080: { open: true, locked: 'booking', label: 'Sarah Kent', booking_id: 'b', booking_times: [1080, 1140] }, 1110: { open: true, locked: 'booking', label: 'Sarah Kent', booking_id: 'b', booking_times: [1080, 1140] } }
    const plan = quickPlan(day(870, 1140, booked), 870, 1020)
    expect(plan.result).toEqual({ from: 870, to: 1140 })
    expect(plan.note).toBe('Your booking with Sarah Kent at 18:00 stays, so the day runs 14:30–19:00. Nothing new can be booked outside 14:30–17:00.')
  })
  it('a day with a booking cannot be made a day off', () => {
    const plan = quickPlan(day(870, 1110, { 900: { open: true, locked: 'booking', label: 'Sarah Kent', booking_id: 'b', booking_times: [900, 960] } }), null, null)
    expect(plan.blocked).toBe(true)
    expect(plan.note).toMatch(/cannot be a day off/)
  })
  it('a day off with nothing on it', () => {
    const plan = quickPlan(day(870, 1110), null, null)
    expect(plan.open).toEqual([])
    expect(plan.blocked).toBe(false)
  })
  it('knows when nothing changes', () => expect(quickPlan(day(870, 1110), 870, 1110).unchanged).toBe(true))
})
