import { describe, expect, it } from 'vitest'
import { canShare, paymentWords, shareText, whatsappShareLink } from './shareBooking.js'

const bank = { configured: true, accountName: 'V Massage', bankName: 'WISE', sortCode: '00-00-00', accountNumber: '00000000', note: '' }
const booking = (changes = {}) => ({
  booking_status: 'confirmed', date: '2026-10-29', start_minutes: 1050, treatment_duration_minutes: 120, total_gbp: 120, booking_reference: 'VM-1234',
  address_snapshot: '55 Altenburg Gardens, London SW11 1JH', booking_email_snapshot: 'andreas@example.test', client_note: 'Bad knee', admin_note: 'Parking round the back',
  id: '0b1c2d3e-0000-4000-8000-000000000001', clients: { first_name: 'Andreas', phone: '07700 900123', email: 'andreas@example.test' },
  booking_sessions: [{ position: 1, service_name_snapshot: 'Deep tissue', duration_minutes: 120 }],
  booking_payments: { method: 'bank_transfer', status: 'awaiting_transfer', payment_reference: 'VM-1234' }, ...changes,
})

describe('the booking details the Admin sends a client', () => {
  it('says the date, time, address, treatment, length, price and how the money stands, with *bold* for WhatsApp', () => {
    expect(shareText(booking({ booking_payments: { method: 'bank_transfer', status: 'paid' } }), bank).split('\n')).toEqual([
      '*Massage booking – Thu 29 Oct, 17:30–19:30*',
      '55 Altenburg Gardens, London SW11 1JH',
      'Deep tissue · 120 min · £120.00',
      'Payment: paid',
    ])
  })
  it('adds the bank details the client already sees, with the reference, while a transfer is still due', () => {
    const text = shareText(booking(), bank)
    expect(text).toContain('Payment: bank transfer – awaiting payment')
    expect(text).toContain('Please pay by bank transfer to:\nName: V Massage\nBank: WISE\nSort code: 00-00-00\nAccount number: 00000000\nReference: VM-1234')
    // No bank details are made up when none are set.
    expect(shareText(booking(), { configured: false })).not.toContain('Please pay')
  })
  it('names two sessions with their lengths, and says cash plainly', () => {
    const two = booking({ treatment_duration_minutes: 90, total_gbp: 135, booking_sessions: [{ position: 2, service_name_snapshot: 'Sports', duration_minutes: 30 }, { position: 1, service_name_snapshot: 'Deep tissue', duration_minutes: 60 }],
      booking_payments: { method: 'cash', status: 'approved' } })
    expect(shareText(two, bank)).toContain('Deep tissue 60 min + Sports 30 min · 90 min · £135.00\nPayment: cash, due at the appointment')
    expect(paymentWords(booking({ booking_payments: { method: 'cash', status: 'awaiting_approval' } }))).toBe('Payment: cash, waiting for my approval')
  })
  it('never says the notes, the client\'s own phone or email, or the booking\'s id', () => {
    const text = shareText(booking(), bank)
    for (const secret of ['Bad knee', 'Parking', '07700', 'andreas@example.test', '0b1c2d3e']) expect(text).not.toContain(secret)
  })
  it('opens WhatsApp at the client\'s own chat with the message, only when there is a usable number', () => {
    expect(whatsappShareLink(booking(), 'Hi there')).toBe('https://wa.me/447700900123?text=Hi%20there')
    expect(whatsappShareLink(booking({ clients: { phone: '' } }), 'Hi')).toBeNull()
  })
  it('does not share a cancelled booking', () => {
    expect(canShare(booking())).toBe(true)
    expect(canShare(booking({ booking_status: 'cancelled' }))).toBe(false)
  })
})
