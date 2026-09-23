import { describe, expect, it } from 'vitest'
import { getAvailableTimes } from './schedulingEngine'

describe('Chain Mode scheduling engine', () => {
  it('returns the anchor time for an empty anchored day', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '10:00',
        end: '20:00',
      },
      anchor: '15:00',
      bookings: [],
      holds: [],
      blockedPeriods: [],
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual(['15:00'])
  })

  it('returns multiple valid times for an empty day without an anchor', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '10:00',
        end: '14:00',
      },
      anchor: null,
      bookings: [],
      holds: [],
      blockedPeriods: [],
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual([
      '10:00',
      '10:30',
      '11:00',
      '11:30',
      '12:00',
      '12:30',
      '13:00',
    ])
  })

  it('returns the correct before-chain slot', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '10:00',
        end: '20:00',
      },
      anchor: null,
      bookings: [
        {
          start: '15:00',
          end: '16:00',
        },
      ],
      holds: [],
      blockedPeriods: [],
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toContain('13:00')
  })

  it('returns the correct after-chain slot', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '10:00',
        end: '20:00',
      },
      anchor: null,
      bookings: [
        {
          start: '15:00',
          end: '16:00',
        },
      ],
      holds: [],
      blockedPeriods: [],
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toContain('17:00')
  })

  it('moves the before-chain slot earlier for a 90-minute treatment', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '10:00',
        end: '20:00',
      },
      anchor: null,
      bookings: [
        {
          start: '15:00',
          end: '16:00',
        },
      ],
      holds: [],
      blockedPeriods: [],
      requestedDurationMinutes: 90,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual(['12:30', '17:00'])
  })

  it('does not return an after-chain slot when the treatment would finish after working hours', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '10:00',
        end: '18:00',
      },
      anchor: null,
      bookings: [
        {
          start: '15:00',
          end: '16:00',
        },
      ],
      holds: [],
      blockedPeriods: [],
      requestedDurationMinutes: 90,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual(['12:30'])
  })

  it('allows the last treatment to finish exactly at the end of working hours', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '10:00',
        end: '20:00',
      },
      anchor: null,
      bookings: [],
      holds: [],
      blockedPeriods: [],
      requestedDurationMinutes: 120,
      travelBufferMinutes: 60,
    })

    expect(result.at(-1)).toBe('18:00')
  })

  it('uses the outer boundaries of multiple bookings and does not expose internal gaps', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '10:00',
        end: '22:00',
      },
      anchor: null,
      bookings: [
        {
          start: '15:00',
          end: '16:00',
        },
        {
          start: '18:00',
          end: '19:00',
        },
      ],
      holds: [],
      blockedPeriods: [],
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual(['13:00', '20:00'])
  })

  it('removes a chain-edge slot when a blocked period overlaps it', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '10:00',
        end: '20:00',
      },
      anchor: null,
      bookings: [
        {
          start: '15:00',
          end: '16:00',
        },
      ],
      holds: [],
      blockedPeriods: [
        {
          start: '17:00',
          end: '18:00',
        },
      ],
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual(['13:00'])
  })

  it('treats an active hold like a temporary booking in the chain', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '10:00',
        end: '22:00',
      },
      anchor: null,
      bookings: [
        {
          start: '15:00',
          end: '16:00',
        },
      ],
      holds: [
        {
          start: '17:00',
          end: '18:00',
          expiresAt: '2026-09-23T16:30:00Z',
        },
      ],
      blockedPeriods: [],
      currentTime: '2026-09-23T15:30:00Z',
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual(['13:00', '19:00'])
  })

  it('ignores an expired hold', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '10:00',
        end: '20:00',
      },
      anchor: null,
      bookings: [
        {
          start: '15:00',
          end: '16:00',
        },
      ],
      holds: [
        {
          start: '17:00',
          end: '18:00',
          expiresAt: '2026-09-23T14:30:00Z',
        },
      ],
      blockedPeriods: [],
      currentTime: '2026-09-23T15:30:00Z',
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual(['13:00', '17:00'])
  })
})
