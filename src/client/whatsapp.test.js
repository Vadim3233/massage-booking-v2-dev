import { describe, expect, it } from 'vitest'
import { appointmentHello, whatsappLink } from './whatsapp.js'
import { checkWhatsApp } from '../admin/whatsappApi.js'

describe('WhatsApp me button', () => {
  it('links to the number with the message started', () => {
    expect(whatsappLink('447700900123', 'Hi Vadim, a question?')).toBe('https://wa.me/447700900123?text=Hi%20Vadim%2C%20a%20question%3F')
    expect(whatsappLink('447700900123')).toBe('https://wa.me/447700900123')
  })
  it('names the appointment', () => {
    expect(appointmentHello({ date: '2026-11-22', start_minutes: 600, booking_reference: 'VAD-123' })).toBe("Hi Vadim, it's about my appointment on Sunday, 22 November 2026 at 10:00 (VAD-123).")
    expect(appointmentHello(null)).toBe("Hi Vadim, it's about my appointment.")
  })
  it('turns a UK number into the WhatsApp form and checks it', () => {
    expect(checkWhatsApp({ number: '07700 900123', show: true })).toEqual({ digits: '447700900123', problem: '' })
    expect(checkWhatsApp({ number: '+44 7700 900123', show: true }).digits).toBe('447700900123')
    expect(checkWhatsApp({ number: '', show: true }).problem).toMatch(/Add your WhatsApp number/)
    expect(checkWhatsApp({ number: '', show: false }).problem).toBe('')
    expect(checkWhatsApp({ number: '0770090012', show: true }).problem).toMatch(/check the number/)
  })
})
