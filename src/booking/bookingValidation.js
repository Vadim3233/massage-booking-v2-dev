import { getAvailableTimes } from '../scheduling/schedulingEngine'

export const BOOKING_VALIDATION_REASONS = Object.freeze({
  INVALID_START_TIME: 'invalid_start_time',
  SLOT_NOT_AVAILABLE: 'slot_not_available',
})

function isValidStartTime(startTime) {
  if (typeof startTime !== 'string') {
    return false
  }

  const match = /^(\d{2}):(\d{2})$/.exec(startTime)

  if (!match) {
    return false
  }

  const hours = Number(match[1])
  const minutes = Number(match[2])

  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59
}

/**
 * Validates a requested booking start against the same scheduling rules
 * used to generate public availability.
 *
 * This is intentionally a thin layer over getAvailableTimes so booking
 * creation and availability cannot drift into separate rule sets.
 */
export function validateBookingSlot({
  startTime,
  workingHours,
  anchor,
  bookings = [],
  holds = [],
  blockedPeriods = [],
  currentTime,
  requestedDurationMinutes,
  travelBufferMinutes = 60,
}) {
  if (!isValidStartTime(startTime)) {
    return {
      valid: false,
      reason: BOOKING_VALIDATION_REASONS.INVALID_START_TIME,
    }
  }

  const availableTimes = getAvailableTimes({
    workingHours,
    anchor,
    bookings,
    holds,
    blockedPeriods,
    currentTime,
    requestedDurationMinutes,
    travelBufferMinutes,
  })

  if (!availableTimes.includes(startTime)) {
    return {
      valid: false,
      reason: BOOKING_VALIDATION_REASONS.SLOT_NOT_AVAILABLE,
    }
  }

  return {
    valid: true,
    reason: null,
  }
}
