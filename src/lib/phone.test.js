import { describe, expect, it } from 'vitest'
import { phoneProblem } from './phone.js'

describe('does a typed phone number look real', () => {
  it('accepts UK numbers written in the usual ways', () => {
    for (const phone of ['07700 900123', '07700900123', '+44 7700 900123', '+44 (0)7700 900123', '0044 7700 900123', '447700900123', '7700 900123',
      '020 7946 0000', '(020) 7946-0000', '+44 20 7946 0000', '0800 123456', '016977 2345', '+44 7700 900123 ext 4567'])
      expect(phoneProblem(phone), phone).toBe('')
  })
  it('accepts numbers from other countries that start with + or 00', () => {
    for (const phone of ['+1 415 555 0100', '+33 6 12 34 56 78', '0049 151 23456789', '+7 912 345 67 89']) expect(phoneProblem(phone), phone).toBe('')
  })
  it('says how many digits too many a UK number has', () => {
    expect(phoneProblem('077009001234')).toMatch(/one digit too many/)
    expect(phoneProblem('+44 77009001234')).toMatch(/one digit too many/)
    expect(phoneProblem('0770090012345')).toMatch(/2 digits too many/)
  })
  it('says when a UK number is too short', () => {
    for (const phone of ['0770090012', '+44 770090012', '020 7946']) expect(phoneProblem(phone), phone).toMatch(/too short/)
  })
  it('names a number that cannot be right', () => {
    for (const phone of ['12345', 'abc', '+1 23', '+123456789012345678', '123 456 7890', '07700+900123']) expect(phoneProblem(phone), phone).toMatch(/doesn't look right|too/)
  })
  it('leaves an empty box to be asked for elsewhere', () => {
    for (const phone of ['', '   ', null, undefined]) expect(phoneProblem(phone)).toBe('')
  })
})
