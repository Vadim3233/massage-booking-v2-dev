import { expect, it } from 'vitest'
import { wiseLinkOf } from './wiseLink.js'

it('tidies a Wise payment link however it is pasted', () => {
  expect(wiseLinkOf('https://wise.com/pay/me/vadims119')).toBe('https://wise.com/pay/me/vadims119')
  expect(wiseLinkOf('  wise.com/pay/me/vadims119 ')).toBe('https://wise.com/pay/me/vadims119')
  expect(wiseLinkOf('http://www.Wise.com/pay/me/vadims119')).toBe('https://wise.com/pay/me/vadims119')
  expect(wiseLinkOf('https://wise.com/pay/r/AbC123?x=1')).toBe('https://wise.com/pay/r/AbC123?x=1')
})

it('refuses anything that is not a Wise payment link', () => {
  for (const bad of ['', null, 'https://wise.com.evil.example/pay/me/x', 'https://evil.example/wise.com/pay/me/x', 'https://wise.com/', 'https://wise.com/login',
    'javascript:alert(1)//wise.com/pay/me/x', 'https://wise.com/pay/me/x"onmouseover', 'https://wise.com/pay/me/x y', '@vadims119']) expect(wiseLinkOf(bad)).toBe('')
})

it('adds the Wise line as its own paragraph straight after the bank details', async () => {
  const { withWiseLine, wiseLines } = await import('./wiseLink.js')
  expect(wiseLines('')).toEqual([])
  expect(wiseLines('https://evil.example/pay')).toEqual([])
  const body = 'Payment of £90.00 is still due, using the reference VDM-1.\n\nAccount name: V\nSort code: 00-00-00\nAccount number: 00000000\nBank: WISE\n\nSee or change your booking: {link}'
  expect(withWiseLine(body, 'wise.com/pay/me/vadims119')).toBe('Payment of £90.00 is still due, using the reference VDM-1.\n\nAccount name: V\nSort code: 00-00-00\nAccount number: 00000000\nBank: WISE\n\nHave Wise? Pay here: https://wise.com/pay/me/vadims119\n(please add the reference above)\n\nSee or change your booking: {link}')
  const gift = 'To pay:\n\nAccount name: V\nSort code: 00-00-00\nAccount number: 00000000\nReference: GV-1'
  expect(withWiseLine(gift, 'https://wise.com/pay/me/vadims119').endsWith('Reference: GV-1\n\nHave Wise? Pay here: https://wise.com/pay/me/vadims119\n(please add the reference above)')).toBe(true)
  expect(withWiseLine('Your appointment is confirmed. I have received your payment.', 'https://wise.com/pay/me/vadims119')).toBe('Your appointment is confirmed. I have received your payment.')
  expect(withWiseLine(body, '')).toBe(body)
  expect(withWiseLine(body, 'https://evil.example/x')).toBe(body)
  const once = withWiseLine(body, 'https://wise.com/pay/me/vadims119')
  expect(withWiseLine(once, 'https://wise.com/pay/me/vadims119')).toBe(once)
})
