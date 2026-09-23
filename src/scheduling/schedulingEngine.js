function timeToMinutes(time) {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

function minutesToTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export function getAvailableTimes({
  workingHours,
  anchor,
  bookings = [],
  requestedDurationMinutes,
  travelBufferMinutes = 60,
}) {
  const workingStart = timeToMinutes(workingHours.start)
  const workingEnd = timeToMinutes(workingHours.end)

  // Empty day with an anchor:
  // the anchor is the first public booking opportunity.
  if (bookings.length === 0 && anchor) {
    return [anchor]
  }

  // Empty day without an anchor:
  // show 30-minute start intervals where the treatment itself
  // can finish within working hours.
  if (bookings.length === 0 && !anchor) {
    const times = []

    for (
      let start = workingStart;
      start + requestedDurationMinutes <= workingEnd;
      start += 30
    ) {
      times.push(minutesToTime(start))
    }

    return times
  }

  // Existing chain:
  // find the earliest treatment start and latest treatment end.
  const bookingStarts = bookings.map((booking) =>
    timeToMinutes(booking.start)
  )
  const bookingEnds = bookings.map((booking) =>
    timeToMinutes(booking.end)
  )

  const chainStart = Math.min(...bookingStarts)
  const chainEnd = Math.max(...bookingEnds)

  // Before chain:
  // treatment -> travel -> existing chain
  const beforeChainStart =
    chainStart - travelBufferMinutes - requestedDurationMinutes

  // After chain:
  // existing chain -> travel -> treatment
  const afterChainStart = chainEnd + travelBufferMinutes

  const availableTimes = []

  // Working hours apply to treatment time itself.
  if (beforeChainStart >= workingStart) {
    availableTimes.push(minutesToTime(beforeChainStart))
  }

  if (afterChainStart + requestedDurationMinutes <= workingEnd) {
    availableTimes.push(minutesToTime(afterChainStart))
  }

  return availableTimes
}
