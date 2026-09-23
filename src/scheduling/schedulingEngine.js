function timeToMinutes(time) {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

function minutesToTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function intervalsOverlap(startA, endA, startB, endB) {
  return startA < endB && endA > startB
}

function isHoldActive(hold, currentTime) {
  if (!hold.expiresAt) {
    return true
  }

  const now = currentTime ? Date.parse(currentTime) : Date.now()
  const expiresAt = Date.parse(hold.expiresAt)

  return Number.isNaN(expiresAt) || expiresAt > now
}

function overlapsBlockedPeriod(start, end, blockedPeriods) {
  return blockedPeriods.some((period) =>
    intervalsOverlap(
      start,
      end,
      timeToMinutes(period.start),
      timeToMinutes(period.end)
    )
  )
}

export function getAvailableTimes({
  workingHours,
  anchor,
  bookings = [],
  holds = [],
  blockedPeriods = [],
  currentTime,
  requestedDurationMinutes,
  travelBufferMinutes = 60,
}) {
  const workingStart = timeToMinutes(workingHours.start)
  const workingEnd = timeToMinutes(workingHours.end)

  const activeHolds = holds.filter((hold) =>
    isHoldActive(hold, currentTime)
  )

  const chainItems = [...bookings, ...activeHolds]

  // Empty day with an anchor:
  // the anchor is the first public booking opportunity.
  if (chainItems.length === 0 && anchor) {
    const anchorStart = timeToMinutes(anchor)
    const anchorEnd = anchorStart + requestedDurationMinutes

    if (
      anchorStart < workingStart ||
      anchorEnd > workingEnd ||
      overlapsBlockedPeriod(anchorStart, anchorEnd, blockedPeriods)
    ) {
      return []
    }

    return [anchor]
  }

  // Empty day without an anchor:
  // show 30-minute start intervals where the treatment itself
  // can finish within working hours.
  if (chainItems.length === 0 && !anchor) {
    const times = []

    for (
      let start = workingStart;
      start + requestedDurationMinutes <= workingEnd;
      start += 30
    ) {
      const end = start + requestedDurationMinutes

      if (!overlapsBlockedPeriod(start, end, blockedPeriods)) {
        times.push(minutesToTime(start))
      }
    }

    return times
  }

  // Existing chain:
  // confirmed bookings and active holds both participate in the chain.
  // Only the outer boundaries are exposed publicly; internal gaps remain hidden.
  const chainStarts = chainItems.map((item) =>
    timeToMinutes(item.start)
  )
  const chainEnds = chainItems.map((item) =>
    timeToMinutes(item.end)
  )

  const chainStart = Math.min(...chainStarts)
  const chainEnd = Math.max(...chainEnds)

  // Before chain:
  // treatment -> travel -> existing chain
  const beforeChainStart =
    chainStart - travelBufferMinutes - requestedDurationMinutes
  // After chain:
  // existing chain -> travel -> treatment
  const afterChainStart = chainEnd + travelBufferMinutes
  const afterChainTreatmentEnd =
    afterChainStart + requestedDurationMinutes

  const availableTimes = []

  // For edge slots, blocked periods apply to the whole reserved interval,
  // including the required travel between the new treatment and the chain.
  const beforeReservedStart = beforeChainStart
  const beforeReservedEnd = chainStart

  if (
    beforeChainStart >= workingStart &&
    !overlapsBlockedPeriod(
      beforeReservedStart,
      beforeReservedEnd,
      blockedPeriods
    )
  ) {
    availableTimes.push(minutesToTime(beforeChainStart))
  }

  const afterReservedStart = chainEnd
  const afterReservedEnd = afterChainTreatmentEnd

  if (
    afterChainTreatmentEnd <= workingEnd &&
    !overlapsBlockedPeriod(
      afterReservedStart,
      afterReservedEnd,
      blockedPeriods
    )
  ) {
    availableTimes.push(minutesToTime(afterChainStart))
  }

  return availableTimes
}
