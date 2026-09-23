export const PUBLIC_SESSION_DURATIONS_MINUTES = [60, 90, 120]

export function buildBookingSessionPlan(sessionDurationsMinutes = []) {
  if (!Array.isArray(sessionDurationsMinutes) || sessionDurationsMinutes.length === 0) {
    throw new Error('At least one session duration is required')
  }

  const durations = sessionDurationsMinutes.map((duration) => Number(duration))

  if (
    durations.some(
      (duration) =>
        !Number.isInteger(duration) ||
        !PUBLIC_SESSION_DURATIONS_MINUTES.includes(duration)
    )
  ) {
    throw new Error('Unsupported session duration')
  }

  return {
    sessionCount: durations.length,
    sessionDurationsMinutes: [...durations],
    treatmentDurationMinutes: durations.reduce(
      (total, duration) => total + duration,
      0
    ),
  }
}
