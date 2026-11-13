// A day off in the Agenda is a warm sunrise card, not a grey line. Under "Day off!" comes one short, happy line.
// The line is picked from the date, so the same day always says the same thing and the next day off says something else.

export const CHEER_LINES = [
  'No alarms, no oils, no stairs. Enjoy it.',
  'Your hands have earned a rest.',
  'Coffee first. Everything else later.',
  'Today the only appointment is with yourself.',
  'Sleep in. You deserve it.',
  'Go for a walk. Look at the sky.',
  'Rest is part of the job.',
  'Family day.',
  'Recharge today, strong hands tomorrow.',
  'Nothing to carry, nowhere to be.',
  'Treat yourself today.',
  'Switch off. The diary will wait.',
]

// Days since 1 Jan 1970 for a 'YYYY-MM-DD' date, so dates a week apart land on different lines.
const dayNumber = date => Math.round(Date.parse(`${date}T12:00:00Z`) / 86400000)

export function cheerLine(date, lines = CHEER_LINES) {
  const n = dayNumber(date)
  if (!Number.isFinite(n) || !lines.length) return lines[0] || ''
  // Stepping by 5 (which shares no factor with 12) means a weekly day off walks through every line before one comes back.
  return lines[(((n * 5) % lines.length) + lines.length) % lines.length]
}

// Which quiet lines in the Agenda are a day off: the usual day off, or a special day off with no hours.
export const isDayOff = item => item.kind === 'closed' || item.kind === 'off'
