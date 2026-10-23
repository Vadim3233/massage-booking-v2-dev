import { describe, expect, it } from 'vitest'
import { canShare, cancellationWords, fillShareMessage, paymentWords, combinedReminderText, reminderDue, reminderText, SHARE_BLANKS, shareMessageProblem, shareText, shareValues, STANDARD_SHARE_MESSAGE, whatsappShareLink } from './shareBooking.js'
import { createShareMessageApi } from './shareMessageApi.js'

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
      'Hi! Thank you so much for booking with me, I am really looking forward to seeing you.',
      '',
      '*Massage booking – Thu 29 Oct, 17:30–19:30*',
      '55 Altenburg Gardens, London SW11 1JH',
      'Deep tissue: One 2-hour session for 1 person – £120.00',
      'Payment: paid',
      '',
      'If anything changes or you have any questions, just message me here. See you soon!',
      '',
      'Warm wishes,',
      'Vad',
    ])
  })
  it('keeps the bank details out of the standard message, which is warm and signed', () => {
    const text = shareText(booking(), bank)
    expect(text).toContain('Payment: bank transfer – awaiting payment')
    expect(text).not.toContain('Please pay')
    expect(text.startsWith('Hi! Thank you')).toBe(true)
    expect(text.endsWith('Warm wishes,\nVad')).toBe(true)
  })
  it('adds the bank details the client already sees, with the reference, while a transfer is still due, when the wording has the blank', () => {
    const text = shareText(booking(), bank, '{payment}\n\n{bank details}')
    expect(text).toContain('Payment: bank transfer – awaiting payment')
    expect(text).toContain('Please pay by bank transfer to:\nName: V Massage\nBank: WISE\nSort code: 00-00-00\nAccount number: 00000000\nReference: VM-1234')
    // No bank details are made up when none are set.
    expect(shareText(booking(), { configured: false }, '{bank details}')).toBe('')
  })
  it('names two sessions with their lengths, and says cash plainly', () => {
    const two = booking({ treatment_duration_minutes: 90, total_gbp: 135, booking_sessions: [{ position: 2, service_name_snapshot: 'Sports', duration_minutes: 30 }, { position: 1, service_name_snapshot: 'Deep tissue', duration_minutes: 60 }],
      booking_payments: { method: 'cash', status: 'approved' } })
    expect(shareText(two, bank)).toContain('Deep tissue + Sports: Two sessions for 2 people, one after the other (60 min + 30 min) – 1 hour 30 minutes in total – £135.00\nPayment: cash, due at the appointment')
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
  it('fills the Admin\'s own wording, leaving out a line whose blank has nothing to say', () => {
    const wording = 'Hi! See you {date} at {time}.\n\n{address}\n{treatment}\n{payment}\n\n{bank details}\n\nThanks, V'
    expect(shareText(booking({ booking_payments: { method: 'cash', status: 'approved' }, address_snapshot: '' }), bank, wording))
      .toBe('Hi! See you Thu 29 Oct at 17:30–19:30.\n\nDeep tissue: One 2-hour session for 1 person – £120.00\nPayment: cash, due at the appointment\n\nThanks, V')
    expect(shareText(booking(), bank, wording)).toContain('Payment: bank transfer – awaiting payment\n\nPlease pay by bank transfer to:\nName: V Massage')
    // Empty wording is the standard one, which reads exactly as before there was a choice.
    expect(shareText(booking(), bank, '  ')).toBe(shareText(booking(), bank))
    expect(fillShareMessage(STANDARD_SHARE_MESSAGE, shareValues(booking(), bank))).toBe(shareText(booking(), bank))
  })
  it('allows only the blanks listed, written exactly, as the database does', () => {
    for (const ok of ['', 'Plain words', SHARE_BLANKS.map(name => `{${name}}`).join(' ')]) expect(shareMessageProblem(ok)).toBe('')
    for (const bad of ['{phone}', '{note}', '{Date}', '{date', 'date}', '{ date }']) expect(shareMessageProblem(bad)).toBe('Only the blanks listed can be used, each in curly brackets.')
    expect(shareMessageProblem('x'.repeat(1001))).toBe('The share message can be up to 1000 characters.')
  })
  it('does not share a cancelled booking', () => {
    expect(canShare(booking())).toBe(true)
    expect(canShare(booking({ booking_status: 'cancelled' }))).toBe(false)
  })
})

describe('reading and saving the share message', () => {
  const settings = (row, rpcError = null) => {
    const calls = []
    return { calls, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }),
      rpc: async (name, args) => { calls.push([name, args]); return { error: rpcError } } }
  }
  it('reads the saved wording, or nothing for the standard one', async () => {
    expect(await createShareMessageApi(settings({ value: 'Hi {date}' })).get()).toBe('Hi {date}')
    expect(await createShareMessageApi(settings(null)).get()).toBe('')
  })
  it('saves the standard wording, or an empty one, as nothing', async () => {
    const client = settings(null)
    const api = createShareMessageApi(client)
    await api.save('  Hi {date}  ')
    await api.save(STANDARD_SHARE_MESSAGE)
    await api.save('   ')
    expect(client.calls).toEqual([['admin_save_share_message', { p_text: 'Hi {date}' }], ['admin_save_share_message', { p_text: null }], ['admin_save_share_message', { p_text: null }]])
  })
  it('says plainly why a save did not work, and nothing more', async () => {
    await expect(createShareMessageApi(settings(null, { message: 'Only the blanks listed can be used, each in curly brackets' })).save('{x}')).rejects.toThrow('Only the blanks listed can be used, each in curly brackets.')
    await expect(createShareMessageApi(settings(null, { code: 'PGRST202', message: 'Could not find the function public.admin_save_share_message(p_text)' })).save('Hi')).rejects.toThrow('Saving your own wording is not switched on yet.')
    await expect(createShareMessageApi(settings(null, { message: 'permission denied for table secrets' })).save('Hi')).rejects.toThrow('Could not save. Please check your connection and try again.')
  })
})

describe('the cancellation line', () => {
  const terms = (changes = {}) => ({ open: true, ended: false, free_until: '2026-10-28T17:30:00Z', ...changes })
  it('says until when the client can cancel or move for free, in London time, and what happens after', () => {
    expect(cancellationWords(terms())).toBe('Free to cancel or move until Wed 28 Oct, 17:30. After that, the full price may be charged.')
    // Summer time: 18:00 UTC on Saturday 24 Oct is 19:00 in London; the clocks go back the next day.
    expect(cancellationWords(terms({ free_until: '2026-10-24T18:00:00Z' }))).toBe('Free to cancel or move until Sat 24 Oct, 19:00. After that, the full price may be charged.')
  })
  it('says plainly when the free period has ended, and says nothing for a booking that can no longer change or when the terms are unknown', () => {
    expect(cancellationWords(terms({ ended: true }))).toBe('The free cancellation period has ended.')
    expect(cancellationWords(terms({ open: false }))).toBe('')
    expect(cancellationWords(null)).toBe('')
  })
  it('comes after the payment line in the standard message, and can be used in the Admin\'s own wording', () => {
    const lines = shareText(booking({ booking_payments: { method: 'cash', status: 'approved' } }), bank, undefined, terms()).split('\n')
    const at = lines.indexOf('Payment: cash, due at the appointment')
    expect(lines.slice(at, at + 2)).toEqual(['Payment: cash, due at the appointment', 'Free to cancel or move until Wed 28 Oct, 17:30. After that, the full price may be charged.'])
    expect(shareMessageProblem('Terms: {cancellation}')).toBe('')
    expect(SHARE_BLANKS).toContain('cancellation')
    expect(shareText(booking(), bank, 'Terms: {cancellation}', terms({ ended: true }))).toBe('Terms: The free cancellation period has ended.')
  })
})

describe('the payment reminder', () => {
  const after = new Date('2026-10-29T20:00:00Z')
  const before = new Date('2026-10-20T09:00:00Z')
  const pay = (status, method = 'bank_transfer') => booking({ booking_payments: { method, status, payment_reference: 'VM-1234' } })
  it('is for a bank transfer not yet received, once the appointment has started', () => {
    expect(reminderDue(pay('awaiting_transfer'), after)).toBe(true)
    expect(reminderDue(pay('awaiting_verification'), after)).toBe(true)
    expect(reminderDue(pay('awaiting_transfer'), before)).toBe(false)
  })
  it('is not for a paid, refunded, cash, cancelled or missed booking', () => {
    expect(reminderDue(pay('paid'), after)).toBe(false)
    expect(reminderDue(pay('refunded'), after)).toBe(false)
    expect(reminderDue(pay('approved', 'cash'), after)).toBe(false)
    expect(reminderDue(booking({ booking_status: 'cancelled' }), after)).toBe(false)
    expect(reminderDue(booking({ booking_status: 'no_show' }), after)).toBe(false)
  })
  it('is friendly, says the payment is outstanding, gives the sort code, account number and reference, and says to ignore it if already sent', () => {
    expect(reminderText(pay('awaiting_transfer'), bank)).toBe(
      "Hi Andreas, hope you're feeling good after your session! Just a quick reminder that payment of £120.00 is still outstanding. Here are my details in case they're handy:\n\nSort code: 00-00-00\nAccount number: 00000000\nReference: VM-1234\n\nIf you've already sent it, please ignore this. Thanks so much!\nVad")
  })
  it('offers the bank details again when none are saved, and never says the notes, phone, email or id', () => {
    expect(reminderText(pay('awaiting_transfer'), { configured: false })).toContain('Let me know if you would like my bank details again.')
    const text = reminderText(pay('awaiting_transfer'), bank)
    for (const secret of ['Bad knee', 'Parking', '07700', 'andreas@example.test', '0b1c2d3e']) expect(text).not.toContain(secret)
  })
  it('still greets a client with no first name', () => {
    expect(reminderText(booking({ clients: { phone: '07700 900123' } }), bank).startsWith("Hi, hope you're feeling good")).toBe(true)
  })
})

describe('the combined payment reminder', () => {
  const owing = (id, date, amount) => ({ id, date, start_minutes: 600, booking_reference: 'VM-' + id, total_gbp: amount, booking_payments: { method: 'bank_transfer', status: 'awaiting_transfer', amount_gbp: amount, payment_reference: 'REF-' + id } })
  it('lists each session by date with what it comes to, the total, and one reference to pay it all by', () => {
    const text = combinedReminderText([owing('2', '2026-10-25', 135), owing('1', '2026-10-18', 120)], bank, 'Dan')
    expect(text).toBe(
      "Hi Dan, hope you're feeling good after your sessions! Just a quick reminder that payment is still outstanding:\n\nSun 18 Oct - £120.00\nSun 25 Oct - £135.00\nTotal: £255.00\n\nHere are my details in case they're handy:\n\nSort code: 00-00-00\nAccount number: 00000000\nReference: REF-1\n\nIf you've already sent it, please ignore this. Thanks so much!\nVad")
  })
  it('offers the bank details again when none are saved, and copes with no first name', () => {
    const text = combinedReminderText([owing('1', '2026-10-18', 120), owing('2', '2026-10-25', 135)], { configured: false }, '')
    expect(text.startsWith("Hi, hope you're feeling good")).toBe(true)
    expect(text).toContain('Let me know if you would like my bank details again.')
    expect(text).not.toContain('Sort code')
  })
})
