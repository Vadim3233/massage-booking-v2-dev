import { describe, expect, it } from 'vitest'
import { buildCalendarFile, calendarHref } from './calendarFile.js'

const booking = {
  id: '0b6c7f5e-1111-4222-8333-444455556666', date: '2026-10-21', start_minutes: 960, treatment_duration_minutes: 90, booking_reference: 'VDM-20261012-ABC123',
  address_snapshot: '24 Test Street, Flat 2; top floor, London, SW1 1AA',
}
const now = new Date('2026-10-12T13:45:09.123Z')

describe('calendar file', () => {
  const text = buildCalendarFile(booking, now)
  const lines = text.split('\r\n')

  it('is a complete calendar with one event, written with the line endings the format asks for', () => {
    expect(lines[0]).toBe('BEGIN:VCALENDAR')
    expect(lines.at(-2)).toBe('END:VCALENDAR')
    expect(lines.at(-1)).toBe('')
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1)
    expect(text).not.toMatch(/[^\r]\n/)
  })
  it('starts and ends at the London times of the appointment', () => {
    expect(text).toContain('DTSTART;TZID=Europe/London:20261021T160000')
    expect(text).toContain('DTEND;TZID=Europe/London:20261021T173000')
    expect(text).toContain('TZID:Europe/London')
    expect(text).toContain('DTSTAMP:20261012T134509Z')
    expect(text).toContain('UID:0b6c7f5e-1111-4222-8333-444455556666@vadmassage.com')
  })
  it('puts the address and reference in, with the characters the format reserves written safely', () => {
    expect(text.replace(/\r\n /g, '')).toContain('LOCATION:24 Test Street\\, Flat 2\\; top floor\\, London\\, SW1 1AA')
    expect(text.replace(/\r\n /g, '')).toContain('Booking reference: VDM-20261012-ABC123')
  })
  it('points back to the booking page on this site, when it is told the address', () => {
    const withLink = buildCalendarFile(booking, now, 'https://booking.example.test').replace(/\r\n /g, '')
    expect(withLink).toContain('URL:https://booking.example.test/account?booking=0b6c7f5e-1111-4222-8333-444455556666')
    expect(withLink).toContain('To change or cancel: https://booking.example.test/account?booking=0b6c7f5e')
    expect(text).not.toContain('URL:')
  })
  it('writes an appointment that ends at midnight as 00:00 the next day, never 24:00', () => {
    const late = buildCalendarFile({ ...booking, date: '2026-10-31', start_minutes: 1380, treatment_duration_minutes: 60 }, now)
    expect(late).toContain('DTSTART;TZID=Europe/London:20261031T230000')
    expect(late).toContain('DTEND;TZID=Europe/London:20261101T000000')
    expect(late).not.toContain('T240000')
  })
  it('never lets a line run past 75 bytes', () => {
    const long = buildCalendarFile({ ...booking, address_snapshot: 'Flat 12, Extremely Long Mansion Block Name Here, Kensington Gore Gardens Road' }, now)
    for (const line of long.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
  })
  it('can be offered as a download link', () => {
    expect(calendarHref(text)).toMatch(/^data:text\/calendar;charset=utf-8,BEGIN%3AVCALENDAR/)
  })
  it('leaves out the location when there is no address', () => {
    expect(buildCalendarFile({ ...booking, address_snapshot: null }, now)).not.toContain('LOCATION')
  })
})
