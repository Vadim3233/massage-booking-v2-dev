import { describe, expect, it } from 'vitest'
import { handleCalendarLink } from './calendarLink.js'
import { googleCalendarLink } from '../src/client/booking/calendarFile.js'

const ID = '0b6c7f5e-1111-4222-8333-444455556666'
const booking = (changes = {}) => ({
  id: ID, date: '2026-11-12', start_minutes: 1050, treatment_duration_minutes: 90, address_snapshot: '1 Test Street, London <SW1A 1AA>',
  booking_reference: 'VM-0001', booking_status: 'confirmed', ...changes,
})
function fakeClient(row, error = null) {
  const asked = []
  return { asked, from: table => ({ select: columns => ({ eq: (column, value) => { asked.push({ table, columns, column, value }); return { maybeSingle: async () => ({ data: row, error }) } } }) }) }
}
function fakeResponse() {
  return { statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name.toLowerCase()] = value }, end(text) { this.body = text } }
}
const open = async (url, client) => { const response = fakeResponse(); await handleCalendarLink({ url }, response, { client, origin: 'https://book.example.test' }); return response }

describe('the add-to-calendar page', () => {
  it('shows the appointment with a Google Calendar button and a calendar-file button, never cached', async () => {
    const client = fakeClient(booking())
    const response = await open(`/api/calendar?b=${ID}`, client)
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toMatch(/text\/html/)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toContain('Thursday 12 November 2026')
    expect(response.body).toContain('17:30–19:00')
    expect(response.body).toContain('1 Test Street, London &lt;SW1A 1AA&gt;')
    expect(response.body).toContain(`/api/calendar?b=${ID}&amp;format=ics`)
    expect(response.body).toContain('https://calendar.google.com/calendar/render?')
    expect(client.asked).toEqual([{ table: 'bookings', columns: 'id, date, start_minutes, treatment_duration_minutes, address_snapshot, booking_reference, booking_status', column: 'id', value: ID }])
  })
  it('gives the calendar file itself, for iPhone, Outlook and other calendars', async () => {
    const response = await open(`/api/calendar?b=${ID}&format=ics`, fakeClient(booking()))
    expect(response.headers['content-type']).toBe('text/calendar; charset=utf-8')
    expect(response.body).toContain('DTSTART;TZID=Europe/London:20261112T173000')
    expect(response.body).toContain(`UID:${ID}@vadmassage.com`)
  })
  it('says so for a cancelled appointment, and gives nothing for a link that does not match one', async () => {
    expect((await open(`/api/calendar?b=${ID}&format=ics`, fakeClient(booking({ booking_status: 'cancelled' })))).statusCode).toBe(410)
    expect((await open(`/api/calendar?b=${ID}`, fakeClient(null))).statusCode).toBe(404)
    const client = fakeClient(booking())
    expect((await open('/api/calendar?b=not-an-id', client)).statusCode).toBe(404)
    expect(client.asked).toEqual([])
  })
})

describe('the Google Calendar link', () => {
  it('fills in the title, London times, address and reference', () => {
    const url = new URL(googleCalendarLink(booking(), 'https://book.example.test'))
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render')
    expect(url.searchParams.get('action')).toBe('TEMPLATE')
    expect(url.searchParams.get('text')).toBe('Massage with Vadim')
    expect(url.searchParams.get('dates')).toBe('20261112T173000/20261112T190000')
    expect(url.searchParams.get('ctz')).toBe('Europe/London')
    expect(url.searchParams.get('location')).toBe('1 Test Street, London <SW1A 1AA>')
    expect(url.searchParams.get('details')).toContain('VM-0001')
  })
  it('ends a late appointment at midnight on the next day', () => {
    const url = new URL(googleCalendarLink(booking({ start_minutes: 1380, treatment_duration_minutes: 60 })))
    expect(url.searchParams.get('dates')).toBe('20261112T230000/20261113T000000')
  })
})
