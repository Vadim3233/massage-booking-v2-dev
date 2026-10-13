import { describe, expect, it } from 'vitest'
import { createReceiptsApi, validateReceiptDetails, validateReceiptEdit, whatsappReceiptLink } from './receiptsApi.js'

describe('checking her details before they are saved', () => {
  it('needs a business name and some way to reach her', () => {
    expect(validateReceiptDetails({ name: 'VadMassage', phone: '07700 900123' })).toBe('')
    expect(validateReceiptDetails({ name: 'VadMassage', email: 'hello@example.test' })).toBe('')
    expect(validateReceiptDetails({ name: ' ', phone: '07700 900123' })).toBe('Enter your business name.')
    expect(validateReceiptDetails({ name: 'VadMassage' })).toBe('Add a phone number or an email address.')
  })
  it('catches an email that cannot be right', () => {
    expect(validateReceiptDetails({ name: 'VadMassage', email: 'hello-at-example' })).toBe('That email address does not look right.')
    expect(validateReceiptDetails({ name: 'VadMassage', phone: '07700 900123', email: '' })).toBe('')
  })
})

describe('checking an edit to a receipt', () => {
  const business = { name: 'VadMassage', phone: '07700 900123' }
  it('needs a name on it, words on every line, and her details still complete', () => {
    expect(validateReceiptEdit({ billed_to: 'Clara', lines: ['Massage', 'Travel'], business })).toBe('')
    expect(validateReceiptEdit({ billed_to: ' ', lines: ['Massage'], business })).toBe('Enter who the receipt is for.')
    expect(validateReceiptEdit({ billed_to: 'Clara', lines: ['Massage', '  '], business })).toBe('Every line of the receipt needs its words.')
    expect(validateReceiptEdit({ billed_to: 'Clara', lines: ['Massage'], business: { name: '', phone: '07700 900123' } })).toBe('Enter your business name.')
  })
})

describe('sending a receipt on WhatsApp', () => {
  it('opens the client\'s chat with the receipt typed in', () => {
    const link = whatsappReceiptLink('07700 900123', 'Receipt VM-2026-0001\nTotal paid: £127.00')
    expect(link).toBe('https://wa.me/447700900123?text=Receipt%20VM-2026-0001%0ATotal%20paid%3A%20%C2%A3127.00')
  })
  it('offers nothing without a phone number', () => {
    expect(whatsappReceiptLink('', 'text')).toBeNull()
    expect(whatsappReceiptLink(null, 'text')).toBeNull()
  })
})

describe('what is shown when something fails', () => {
  const failing = message => createReceiptsApi({ rpc: async () => ({ error: { message } }) })
  it('keeps the kind messages written by the server and hides everything else', async () => {
    await expect(failing('A cancelled booking has no receipt').issue('b1')).rejects.toThrow('A cancelled booking has no receipt')
    await expect(failing('There is no email address on this booking').email('b1', 'r1')).rejects.toThrow('There is no email address on this booking')
    await expect(failing('duplicate key value violates unique constraint "booking_receipts_receipt_number_key"').issue('b1')).rejects.toThrow('Could not complete that.')
    await expect(failing('permission denied for table booking_receipts').edit('b1', {})).rejects.toThrow('Could not complete that.')
  })
  it('also keeps the kind messages about a receipt that can no longer be sent', async () => {
    for (const message of ['This booking was cancelled, so its receipt can no longer be sent or changed', 'This payment was refunded, so its receipt can no longer be sent or changed',
      'This appointment was marked as missed, so its receipt can no longer be sent or changed', 'The payment is no longer marked as received, so its receipt can no longer be sent or changed',
      'A missed appointment has no receipt', 'That contains characters that cannot be used']) {
      await expect(failing(message).email('b1', 'r1')).rejects.toThrow(message)
    }
  })
  it('looks at a receipt that exists without making one', async () => {
    const calls = []
    const api = createReceiptsApi({ rpc: async (name, args) => { calls.push([name, args]); return { data: null, error: null } } })
    expect(await api.get('b1')).toBeNull()
    expect(calls).toEqual([['admin_get_receipt', { p_booking_id: 'b1' }]])
  })
  it('sends only the fields of her details, with empty ones as nothing', async () => {
    const calls = []
    const api = createReceiptsApi({ rpc: async (name, args) => { calls.push([name, args]); return { data: null, error: null } } })
    await api.saveDetails({ name: 'VadMassage', phone: '', email: 'hello@example.test', address: '', closing: 'Thank you.', extra: 'ignored' })
    expect(calls).toEqual([['admin_save_receipt_details', { p_details: { name: 'VadMassage', phone: null, email: 'hello@example.test', address: null, closing: 'Thank you.' } }]])
  })
})
