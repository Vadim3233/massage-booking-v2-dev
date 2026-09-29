import { describe, expect, it } from 'vitest'
import {
  BOOKING_VALIDATION_REASONS,
  validateBookingSlot,
} from './bookingValidation'

const baseRequest = {
  workingHours: {
    start: '10:00',
    end: '20:00',
  },
  anchor: null,
  bookings: [],
  holds: [],
  blockedPeriods: [],
  requestedDurationMinutes: 60,
  travelBufferMinutes: 60,
}

describe('shared booking validation', () => {
  it('accepts a start returned by the scheduling engine', () => {
    const result = validateBookingSlot({
      ...baseRequest,
      startTime: '13:00',
    })

    expect(result).toEqual({
      valid: true,
      reason: null,
    })
  })

  it('rejects a malformed start time before scheduling', () => {
    const result = validateBookingSlot({
      ...baseRequest,
      startTime: '1pm',
    })

    expect(result).toEqual({
      valid: false,
      reason: BOOKING_VALIDATION_REASONS.INVALID_START_TIME,
    })
  })

  it('uses the anchor rule for an empty anchored day', () => {
    const validResult = validateBookingSlot({
      ...baseRequest,
      anchor: '15:00',
      startTime: '15:00',
    })
    const invalidResult = validateBookingSlot({
      ...baseRequest,
      anchor: '15:00',
      startTime: '14:30',
    })

    expect(validResult.valid).toBe(true)
    expect(invalidResult).toEqual({
      valid: false,
      reason: BOOKING_VALIDATION_REASONS.SLOT_NOT_AVAILABLE,
    })
  })

  it('accepts a valid chain-edge slot', () => {
    const result = validateBookingSlot({
      ...baseRequest,
      bookings: [
        {
          start: '15:00',
          end: '16:00',
        },
      ],
      startTime: '13:00',
    })

    expect(result.valid).toBe(true)
  })

  it('rejects an internal chain gap that is not publicly available', () => {
    const result = validateBookingSlot({
      ...baseRequest,
      workingHours: {
        start: '10:00',
        end: '22:00',
      },
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
      startTime: '17:00',
    })

    expect(result).toEqual({
      valid: false,
      reason: BOOKING_VALIDATION_REASONS.SLOT_NOT_AVAILABLE,
    })
  })

  it('rejects a chain-edge slot blocked by a blocked period', () => {
    const result = validateBookingSlot({
      ...baseRequest,
      bookings: [
        {
          start: '15:00',
          end: '16:00',
        },
      ],
      blockedPeriods: [
        {
          start: '17:00',
          end: '18:00',
        },
      ],
      startTime: '17:00',
    })

    expect(result).toEqual({
      valid: false,
      reason: BOOKING_VALIDATION_REASONS.SLOT_NOT_AVAILABLE,
    })
  })

  it('treats an active hold as part of the same booking chain', () => {
    const result = validateBookingSlot({
      ...baseRequest,
      workingHours: {
        start: '10:00',
        end: '22:00',
      },
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
          expiresAt: '2026-09-29T12:30:00Z',
        },
      ],
      currentTime: '2026-09-29T11:30:00Z',
      startTime: '19:00',
    })

    expect(result.valid).toBe(true)
  })
})
