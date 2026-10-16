const clock = (date, options) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', ...options }).format(date)

// A moment as the clock in London shows it, in the two pieces a screen puts into a sentence of its own: the day ("Wed 14 Oct", or "Wednesday
// 14 October" when `long`) and the time ("18:20"). The year is added to the day only when it is not the year of `now`. It is null for a value
// that is not a moment, so a screen can leave the sentence out when a time was never recorded.
export function londonMoment(value, { long = false, now = new Date() } = {}) {
  const at = new Date(value)
  if (!value || Number.isNaN(at.getTime())) return null
  const style = long ? 'long' : 'short'
  const year = clock(at, { year: 'numeric' })
  const day = [clock(at, { weekday: style }), clock(at, { day: 'numeric' }), clock(at, { month: style })]
  if (year !== clock(now, { year: 'numeric' })) day.push(year)
  return { day: day.join(' '), time: clock(at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }
}
