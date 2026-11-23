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
