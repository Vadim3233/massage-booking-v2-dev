import { describe, expect, it } from 'vitest'
import { applyEdits, changeCount, closeAll, heldLine, hoursSummary, isDayOff, openMinutes, openRuns, visibleRange, withLabels } from './dayGrid.js'

// A Monday as the database reads it: open 14:30 to 21:00, a booking 16:00 to 17:00 with half an hour's travel either side.
const day = () => Array.from({ length: 48 }, (_, index) => {
  const start_minutes = index * 30
  const booked = start_minutes >= 960 && start_minutes < 1020
  const travel = start_minutes === 930 || start_minutes === 1020
  return { start_minutes, open: start_minutes >= 870 && start_minutes < 1260, locked: booked ? 'booking' : travel ? 'travel' : null,
    label: booked ? 'Andreas Grid' : null, booking_id: booked ? 'b1' : null, held: false }
})

describe('the day grid', () => {
  it('applies taps, but never to a locked half hour', () => {
    const rows = applyEdits(day(), { 870: false, 960: false, 840: true })
    expect(rows.find(row => row.start_minutes === 870)).toMatchObject({ open: false, changed: true })
    expect(rows.find(row => row.start_minutes === 840)).toMatchObject({ open: true, changed: true })
    expect(rows.find(row => row.start_minutes === 960)).toMatchObject({ open: true, changed: false })
    expect(changeCount(rows)).toBe(2)
  })
  it('tapping a half hour back to how it was is no change', () => {
    expect(changeCount(applyEdits(day(), { 870: true }))).toBe(0)
  })
  it('shows the hours with an hour either side, or the rest of the day when asked', () => {
    expect(visibleRange(day())).toEqual({ from: 810, to: 1320, moreEarlier: true, moreLater: true })
    expect(visibleRange(day(), { earlier: true, later: true })).toEqual({ from: 0, to: 1440, moreEarlier: false, moreLater: false })
    expect(visibleRange(day().map(row => ({ ...row, open: false, locked: null })))).toMatchObject({ from: 480, to: 1320 })
  })
  it('says the hours as runs of open time', () => {
    expect(hoursSummary(day())).toBe('14:30–21:00')
    const split = applyEdits(day(), { 1050: false, 1080: false })
    expect(openRuns(split)).toEqual([[870, 1050], [1110, 1260]])
    expect(hoursSummary(split)).toBe('14:30–17:30, 18:30–21:00')
    expect(hoursSummary(day().map(row => ({ ...row, open: false })))).toBe('Day off')
  })
  it('closes everything that can be tapped for a day off, and keeps the booking', () => {
    const rows = applyEdits(day(), closeAll(day()))
    expect(isDayOff(rows)).toBe(true)
    expect(openMinutes(rows)).toEqual([930, 960, 990, 1020])
    expect(isDayOff(day())).toBe(false)
  })
  it('names a booking once, on its first half hour, with its times', () => {
    const labels = withLabels(day()).filter(row => row.showLabel).map(row => [row.start_minutes, row.showLabel])
    expect(labels).toEqual([[960, 'Andreas Grid · 16:00–17:00']])
    // A booking that ends on the quarter hour says its real end.
    const quarter = day().map(row => row.booking_id ? { ...row, booking_times: [960, 1035] } : row)
    expect(withLabels(quarter).find(row => row.showLabel).showLabel).toBe('Andreas Grid · 16:00–17:15')
  })
  it('describes held time in runs', () => {
    expect(heldLine([1200, 1230, 1290])).toBe('20:00–21:00, 21:30–22:00')
  })
})
