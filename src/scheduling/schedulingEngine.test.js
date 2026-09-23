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

  it('handles a 120-minute treatment at both chain edges', () => {
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
      holds: [],
      blockedPeriods: [],
      requestedDurationMinutes: 120,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual(['12:00', '17:00'])
  })

  it('uses a custom 30-minute travel buffer', () => {
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
      travelBufferMinutes: 30,
    })

    expect(result).toEqual(['13:30', '16:30'])
  })

  it('supports zero travel buffer when explicitly requested', () => {
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
      travelBufferMinutes: 0,
    })

    expect(result).toEqual(['14:00', '16:00'])
  })

  it('allows a before-chain treatment to start exactly at working-hours start', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '10:00',
        end: '20:00',
      },
      anchor: null,
      bookings: [
        {
          start: '12:00',
          end: '13:00',
        },
      ],
      holds: [],
      blockedPeriods: [],
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual(['10:00', '14:00'])
  })

  it('returns no edge slot when both sides fall outside working hours', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '14:00',
        end: '17:00',
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

    expect(result).toEqual([])
  })

  it('uses chain boundaries correctly when bookings are not sorted', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '10:00',
        end: '22:00',
      },
      anchor: null,
      bookings: [
        {
          start: '18:00',
          end: '19:00',
        },
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

    expect(result).toEqual(['13:00', '20:00'])
  })

  it('uses an active hold as the chain even when there are no confirmed bookings', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '10:00',
        end: '20:00',
      },
      anchor: null,
      bookings: [],
      holds: [
        {
          start: '15:00',
          end: '16:00',
          expiresAt: '2026-09-23T17:00:00Z',
        },
      ],
      blockedPeriods: [],
      currentTime: '2026-09-23T16:00:00Z',
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual(['13:00', '17:00'])
  })

  it('treats a hold expiring exactly now as expired', () => {
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
          expiresAt: '2026-09-23T16:00:00Z',
        },
      ],
      blockedPeriods: [],
      currentTime: '2026-09-23T16:00:00Z',
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual(['13:00', '17:00'])
  })

  it('does not offer an anchor before working hours', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '10:00',
        end: '20:00',
      },
      anchor: '09:30',
      bookings: [],
      holds: [],
      blockedPeriods: [],
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual([])
  })

  it('does not offer an anchor when treatment would finish after working hours', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '10:00',
        end: '20:00',
      },
      anchor: '19:30',
      bookings: [],
      holds: [],
      blockedPeriods: [],
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual([])
  })

  it('does not offer an anchor when a blocked period overlaps the treatment', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '10:00',
        end: '20:00',
      },
      anchor: '15:00',
      bookings: [],
      holds: [],
      blockedPeriods: [
        {
          start: '15:30',
          end: '16:30',
        },
      ],
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual([])
  })

  it('does not reduce empty-day treatment availability because of travel buffer', () => {
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
      travelBufferMinutes: 120,
    })

    expect(result.at(-1)).toBe('13:00')
  })

  it('removes only empty-day starts whose treatment overlaps blocked time', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '10:00',
        end: '14:00',
      },
      anchor: null,
      bookings: [],
      holds: [],
      blockedPeriods: [
        {
          start: '11:00',
          end: '12:00',
        },
      ],
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual([
      '10:00',
      '12:00',
      '12:30',
      '13:00',
    ])
  })

  it('removes an after-chain slot when blocked time overlaps required travel', () => {
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
          start: '16:30',
          end: '16:45',
        },
      ],
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual(['13:00'])
  })

  it('removes a before-chain slot when blocked time overlaps required travel', () => {
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
          start: '14:30',
          end: '14:45',
        },
      ],
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual(['17:00'])
  })


  it('allows an edge slot when blocked time ends exactly at the reserved interval start', () => {
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
          start: '12:00',
          end: '13:00',
        },
      ],
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual(['13:00', '17:00'])
  })

  it('allows an edge slot when blocked time starts exactly at the reserved interval end', () => {
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
          start: '18:00',
          end: '19:00',
        },
      ],
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual(['13:00', '17:00'])
  })

  it('uses the outer boundaries of confirmed bookings and active holds together', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '09:00',
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
          start: '18:00',
          end: '19:00',
          expiresAt: '2026-09-23T18:00:00Z',
        },
      ],
      blockedPeriods: [],
      currentTime: '2026-09-23T16:00:00Z',
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual(['13:00', '20:00'])
  })

  it('ignores expired holds when active holds are also present', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '09:00',
        end: '22:00',
      },
      anchor: null,
      bookings: [],
      holds: [
        {
          start: '12:00',
          end: '13:00',
          expiresAt: '2026-09-23T15:00:00Z',
        },
        {
          start: '15:00',
          end: '16:00',
          expiresAt: '2026-09-23T18:00:00Z',
        },
      ],
      blockedPeriods: [],
      currentTime: '2026-09-23T16:00:00Z',
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual(['13:00', '17:00'])
  })

  it('applies multiple blocked periods independently on an empty day', () => {
    const result = getAvailableTimes({
      workingHours: {
        start: '10:00',
        end: '15:00',
      },
      anchor: null,
      bookings: [],
      holds: [],
      blockedPeriods: [
        {
          start: '10:30',
          end: '11:00',
        },
        {
          start: '13:00',
          end: '13:30',
        },
      ],
      requestedDurationMinutes: 60,
      travelBufferMinutes: 60,
    })

    expect(result).toEqual([
      '11:00',
      '11:30',
      '12:00',
      '13:30',
      '14:00',
    ])
  })

})
