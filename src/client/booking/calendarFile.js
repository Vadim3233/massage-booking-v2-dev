// An appointment as a calendar file (.ics), so it can go straight into the client's own calendar.
const pad = number => String(number).padStart(2, '0')
const clock = (date, minutes) => `${date.replaceAll('-', '')}T${pad(Math.floor(minutes / 60))}${pad(minutes % 60)}00`
const escapeText = text => String(text).replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,').replace(/\r?\n/g, '\\n')

// Calendar files break lines at 75 bytes; the rest carries on after a leading space.
function fold(line) {
  const encoder = new TextEncoder()
  const lines = []
  let current = ''
  let size = 0
  for (const character of line) {
    const bytes = encoder.encode(character).length
    if (size + bytes > (lines.length ? 74 : 75)) { lines.push(current); current = ''; size = 0 }
    current += character
    size += bytes
  }
  lines.push(current)
  return lines.map((text, index) => index ? ` ${text}` : text).join('\r\n')
}

const LONDON = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/London',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0100', 'TZNAME:BST', 'DTSTART:19700329T010000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0000', 'TZNAME:GMT', 'DTSTART:19701025T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
]

export function buildCalendarFile(booking, now = new Date()) {
  const where = [booking.address_line_1_snapshot, booking.address_line_2_snapshot, booking.city_snapshot, booking.postcode_snapshot].filter(Boolean).join(', ')
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//VadMassage//Booking//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    ...LONDON,
    'BEGIN:VEVENT',
    `UID:${booking.id}@vadmassage.com`,
    `DTSTAMP:${now.toISOString().replace(/[-:]|\.\d{3}/g, '')}`,
    `DTSTART;TZID=Europe/London:${clock(booking.date, booking.start_minutes)}`,
    `DTEND;TZID=Europe/London:${clock(booking.date, booking.start_minutes + booking.treatment_duration_minutes)}`,
    'SUMMARY:Massage with Vad',
    ...(where ? [`LOCATION:${escapeText(where)}`] : []),
    `DESCRIPTION:${escapeText(`Booking reference: ${booking.booking_reference}\nTo change or cancel, open your booking on vadmassage.com.`)}`,
    'END:VEVENT', 'END:VCALENDAR',
  ]
  return `${lines.map(fold).join('\r\n')}\r\n`
}

export const calendarHref = text => `data:text/calendar;charset=utf-8,${encodeURIComponent(text)}`
