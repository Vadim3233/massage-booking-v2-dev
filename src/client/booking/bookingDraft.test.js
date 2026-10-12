import { describe, expect, it } from 'vitest'
import { detailProblems } from './bookingDraft.js'

const details = (changes = {}) => ({ first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test', phone: '07700 900123', address_line_1: '1 Test Road', address_line_2: '', city: 'London', postcode: 'SW3 1AA', savedAddressId: '', ...changes })

describe('what is plainly wrong with the details a client typed', () => {
  it('accepts ordinary UK and international numbers, and ordinary postcodes however they are typed', () => {
    for (const phone of ['07700 900123', '+44 7700 900123', '020 7946 0000', '(020) 7946-0000', '+1 415 555 0100']) expect(detailProblems(details({ phone }))).toEqual({})
    for (const postcode of ['SW3 1AA', 'sw3 1aa', 'sw31aa', 'W1A 1AA', 'EC1A 1BB', 'M1 1AE', ' SW1A 2AA ']) expect(detailProblems(details({ postcode }))).toEqual({})
  })
  it('names a number that cannot be right', () => {
    for (const phone of ['12345', 'abc', '1234567890123456', '+44 7700 900123 4567 8901']) expect(detailProblems(details({ phone })).phone).toMatch(/doesn't look right/)
  })
  it('names a postcode that cannot be right', () => {
    for (const postcode of ['ZZZ', '12345', 'SW3 1AAA', 'hello world', 'SW3']) expect(detailProblems(details({ postcode })).postcode).toMatch(/doesn't look right/)
  })
  it('leaves empty fields to be asked for, and does not judge the postcode of a saved address', () => {
    expect(detailProblems(details({ phone: '', postcode: '' }))).toEqual({})
    expect(detailProblems(details({ postcode: 'ZZZ', savedAddressId: 'a1' }))).toEqual({})
  })
})
