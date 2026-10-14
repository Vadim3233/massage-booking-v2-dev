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

// The offset of London from UTC, in minutes, at a moment in time (60 in summer, 0 in winter).
function londonOffsetMinutes(utcMilliseconds) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(utcMilliseconds)).map((part) => [part.type, part.value])
  )
  const wallAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute))
  return Math.round((wallAsUtc - utcMilliseconds) / 60000)
}

// The moment a first appointment is released: the release time on the day before the date, in London time.
// The date is written YYYY-MM-DD and the release time is in minutes after midnight.
export function anchorReleaseInstant(date, releaseMinutes) {
  const [year, month, day] = date.split('-').map(Number)
  const wall = Date.UTC(year, month - 1, day - 1, 0, releaseMinutes)
  // The offset is looked up twice so that the hour either side of the clocks changing still lands on the right moment.
  const first = wall - londonOffsetMinutes(wall) * 60000
  return wall - londonOffsetMinutes(first) * 60000
}

export function getAvailableTimes({
  workingHours,
  anchor: setAnchor,
  date,
  anchorReleaseMinutes = null,
  bookings = [],
  holds = [],
  blockedPeriods = [],
  currentTime,
  requestedDurationMinutes,
  travelBufferMinutes = 60,
}) {
  const workingStart = timeToMinutes(workingHours.start)
  const workingEnd = timeToMinutes(workingHours.end)

  // A first appointment that nobody has booked is released the day before: from then on an empty day is offered as if it had
  // none, so every usual time is available. Once there are bookings the day is a chain and the release changes nothing.
  const now = currentTime ? Date.parse(currentTime) : Date.now()
  const released =
    Boolean(setAnchor) &&
    anchorReleaseMinutes !== null &&
    Boolean(date) &&
    now >= anchorReleaseInstant(date, anchorReleaseMinutes)
  const anchor = released ? null : setAnchor

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
