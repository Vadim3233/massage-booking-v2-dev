import { it, expect } from 'vitest'
import { formatPostcode, paymentStatus } from './paymentPresentation.js'
import { bankFromSettings, chooseBank, paymentConfig } from './paymentConfig.js'
it.each([['sw1a1aa','SW1A 1AA'],[' w1a  0ax ','W1A 0AX'],['gir0aa','GIR 0AA']])('formats %s for display', (input,expected) => expect(formatPostcode(input)).toBe(expected))
it('uses explicit client-friendly payment wording', () => {
 expect(paymentStatus({booking_payments:{status:'awaiting_transfer'}})).toBe('Awaiting your bank transfer')
 expect(paymentStatus({booking_payments:{status:'awaiting_verification'}})).toBe("Transfer sent — I'll check it shortly")
 expect(paymentStatus({booking_payments:{status:'awaiting_approval'}})).toBe('Cash on arrival')
})

it('prefers bank details saved in the app and falls back to the build-time ones', () => {
  const fallback = paymentConfig({ VITE_BANK_ACCOUNT_NAME: 'Env Name', VITE_BANK_SORT_CODE: '000000', VITE_BANK_ACCOUNT_NUMBER: '00000000' })
  const saved = bankFromSettings({ account_name: 'Saved Name', sort_code: '12-34-56', account_number: '12345678', note: 'Use the reference' })
  expect(saved).toMatchObject({ configured: true, accountName: 'Saved Name', note: 'Use the reference' })
  expect(chooseBank(saved, fallback).accountName).toBe('Saved Name')
  expect(chooseBank(null, fallback).accountName).toBe('Env Name')
  expect(chooseBank(bankFromSettings({ account_name: 'Half', sort_code: '12-34', account_number: '1' }), fallback).accountName).toBe('Env Name')
  expect(bankFromSettings(null)).toBeNull()
})
