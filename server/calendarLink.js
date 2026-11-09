import { buildCalendarFile, googleCalendarLink } from '../src/client/booking/calendarFile.js'

// The "Add to your calendar" link in the share message (/calendar/<booking id>). It opens a small page with two buttons: Google Calendar, and a
// calendar file (.ics) that iPhone, Outlook and most other calendars add with one tap. The booking id is a long random number that only the client's
// own message carries, and the page shows nothing beyond what that message already says (date, time, address, reference). It is read fresh every
// time, so a moved appointment gives the new time, and a cancelled one says so instead.
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const escapeHtml = text => String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
const pad = number => String(number).padStart(2, '0')
const clockText = minutes => `${pad(Math.floor((minutes % 1440) / 60))}:${pad(minutes % 60)}`
const dayText = date => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`)).replace(',', '')

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title><style>
:root{color-scheme:light dark;--bg:#f7f5f2;--card:#fff;--text:#1f2a28;--muted:#5d6966;--accent:#2f6f62;--on-accent:#fff;--line:#d9dedc}
@media (prefers-color-scheme:dark){:root{--bg:#141917;--card:#1d2422;--text:#e8eeec;--muted:#a7b3b0;--accent:#8fd1c0;--on-accent:#10211d;--line:#33403c}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:420px;margin:0 auto;padding:32px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}
h1{font-size:1.4rem;margin:0 0 8px}p{margin:0 0 6px;color:var(--muted)}
a.btn{display:block;text-align:center;text-decoration:none;font-weight:600;border-radius:12px;padding:14px 16px;margin-top:12px;min-height:24px}
a.primary{background:var(--accent);color:var(--on-accent)}a.secondary{border:1px solid var(--accent);color:var(--accent)}
a.btn:focus-visible{outline:3px solid var(--accent);outline-offset:2px}.actions{margin-top:20px}small{display:block;margin-top:16px;color:var(--muted)}
</style></head><body><main><div class="card">${body}</div></main></body></html>`
}

function send(response, status, type, text, extra = {}) {
  response.statusCode = status
  response.setHeader('content-type', type)
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-robots-tag', 'noindex')
  for (const [name, value] of Object.entries(extra)) response.setHeader(name, value)
  response.end(text)
}

const notFound = response => send(response, 404, 'text/html; charset=utf-8', page('Appointment not found', '<h1>Appointment not found</h1><p>This calendar link does not match an appointment. Please check the link in your message.</p>'))

// `client` reads the database with full access (the server's own key), only ever this one booking and only these columns.
export async function handleCalendarLink(request, response, { client, origin }) {
  const url = new URL(request.url, origin || 'http://localhost')
  const id = url.searchParams.get('b') || ''
  if (!ID.test(id)) return notFound(response)
  const { data: booking, error } = await client.from('bookings')
    .select('id, date, start_minutes, treatment_duration_minutes, address_snapshot, booking_reference, booking_status').eq('id', id).maybeSingle()
  if (error) return send(response, 500, 'text/html; charset=utf-8', page('Please try again', '<h1>Something went wrong</h1><p>Please try the link again in a moment.</p>'))
  if (!booking) return notFound(response)
  if (booking.booking_status === 'cancelled') {
    return send(response, 410, 'text/html; charset=utf-8', page('Appointment cancelled', '<h1>This appointment was cancelled</h1><p>There is nothing to add to your calendar. If you think this is a mistake, please message me.</p>'))
  }
  if (url.searchParams.get('format') === 'ics') {
    return send(response, 200, 'text/calendar; charset=utf-8', buildCalendarFile(booking, new Date(), origin), { 'content-disposition': 'inline; filename="massage-with-vadim.ics"' })
  }
  const end = booking.start_minutes + booking.treatment_duration_minutes
  const file = `/api/calendar?b=${encodeURIComponent(booking.id)}&format=ics`
  const body = `<h1>Massage with Vadim</h1>
<p><strong>${escapeHtml(dayText(booking.date))}</strong></p>
<p>${clockText(booking.start_minutes)}–${clockText(end)}</p>
${booking.address_snapshot ? `<p>${escapeHtml(booking.address_snapshot)}</p>` : ''}
<div class="actions">
<a class="btn primary" href="${escapeHtml(file)}">Add to iPhone, Outlook or other calendar</a>
<a class="btn secondary" href="${escapeHtml(googleCalendarLink(booking, origin))}" target="_blank" rel="noopener noreferrer">Add to Google Calendar</a>
</div>
<small>If the time changes, open this link again to get the new time.</small>`
  return send(response, 200, 'text/html; charset=utf-8', page('Add to your calendar', body))
}
