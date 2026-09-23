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
  // find the earliest existing treatment start.
  const bookingStarts = bookings.map((booking) =>
    timeToMinutes(booking.start)
  )

  const chainStart = Math.min(...bookingStarts)

  // A new treatment attached before the chain needs:
  //
  // treatment → travel → existing chain
  //
  // Example:
  // 13:00–14:00 treatment
  // 14:00–15:00 travel
  // 15:00 existing booking
  const beforeChainStart =
    chainStart - travelBufferMinutes - requestedDurationMinutes

  const availableTimes = []

  // Working hours refer to treatment time.
  // Therefore the proposed treatment itself must not start
  // before working hours begin.
  if (beforeChainStart >= workingStart) {
    availableTimes.push(minutesToTime(beforeChainStart))
  }

  return availableTimes
}
