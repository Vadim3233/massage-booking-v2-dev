import { describe, expect, it } from 'vitest'
import { contactLinks, directionsLink, whatsappNumber } from './contactLinks.js'

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
    address_snapshot: '10 Saved Street, London, SW1A 1AA' }
  it('offers call, WhatsApp, directions and email', () => {
    const links = Object.fromEntries(contactLinks(booking).map(link => [link.key, link.href]))
    expect(links.call).toBe('tel:07700900123')
    expect(links.whatsapp).toBe('https://wa.me/447700900123')
    expect(links.directions).toBe('https://www.google.com/maps/dir/?api=1&destination=10%20Saved%20Street%2C%20London%2C%20SW1A%201AA')
    expect(links.email).toBe('mailto:booked@example.test')
  })
  it('leaves out what is not recorded', () => {
    expect(contactLinks({ clients: {}, address_snapshot: '1 Road' }).map(link => link.key)).toEqual(['directions'])
  })
})

describe('directions', () => {
  const booking = { address_snapshot: '10 Saved Street, Flat 2, London, SW1A 1AA' }
  it('is the way to the whole address on Google Maps, the same link the booking details offer', () => {
    expect(directionsLink(booking)).toMatchObject({ label: 'Directions', external: true, href: 'https://www.google.com/maps/dir/?api=1&destination=10%20Saved%20Street%2C%20Flat%202%2C%20London%2C%20SW1A%201AA' })
    expect(contactLinks(booking).find(link => link.key === 'directions')).toEqual(directionsLink(booking))
  })
  it('is nothing when no address is recorded', () => {
    expect(directionsLink({})).toBeNull()
    expect(directionsLink({ address_snapshot: '', address_line_1_snapshot: 'ignored: the parts are no longer read' })).toBeNull()
  })
})
