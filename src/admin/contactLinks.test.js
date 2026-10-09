import { describe, expect, it } from 'vitest'
import { contactLinks, whatsappNumber } from './contactLinks.js'

describe('WhatsApp numbers', () => {
  it('turns UK and international formats into the number WhatsApp expects', () => {
    expect(whatsappNumber('+44 7700 900123')).toBe('447700900123')
    expect(whatsappNumber('07700 900123')).toBe('447700900123')
    expect(whatsappNumber('(07700) 900-123')).toBe('447700900123')
    expect(whatsappNumber('0044 7700 900123')).toBe('447700900123')
    expect(whatsappNumber('+1 (415) 555-0100')).toBe('14155550100')
  })
  it('gives nothing for a missing or empty number', () => {
    expect(whatsappNumber(null)).toBeNull()
    expect(whatsappNumber('')).toBeNull()
    expect(whatsappNumber('n/a')).toBeNull()
  })
})

describe('contact links', () => {
  const booking = { clients: { phone: '07700 900123', email: 'a@example.test' }, booking_email_snapshot: 'booked@example.test',
    address_line_1_snapshot: '10 Saved Street', city_snapshot: 'London', postcode_snapshot: 'SW1A 1AA' }
  it('offers call, WhatsApp, directions and email', () => {
    const links = Object.fromEntries(contactLinks(booking).map(link => [link.key, link.href]))
    expect(links.call).toBe('tel:07700900123')
    expect(links.whatsapp).toBe('https://wa.me/447700900123')
    expect(links.directions).toBe('https://www.google.com/maps/dir/?api=1&destination=10%20Saved%20Street%2C%20London%2C%20SW1A%201AA')
    expect(links.email).toBe('mailto:booked@example.test')
  })
  it('leaves out what is not recorded', () => {
    expect(contactLinks({ clients: {}, address_line_1_snapshot: '1 Road' }).map(link => link.key)).toEqual(['directions'])
  })
})
