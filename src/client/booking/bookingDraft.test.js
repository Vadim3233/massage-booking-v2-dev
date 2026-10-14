import { describe, expect, it } from 'vitest'
import { addressFields, addressTyped, blankAddressFields, detailProblems, usualAddress } from './bookingDraft.js'

const details = (changes = {}) => ({ first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test', phone: '07700 900123', address_line_1: '1 Test Road', address_line_2: '', city: 'London', postcode: 'SW3 1AA', savedAddressId: '', ...changes })

describe('what is plainly wrong with the details a client typed', () => {
  it('accepts ordinary UK and international numbers, and ordinary postcodes however they are typed', () => {
    for (const phone of ['07700 900123', '+44 7700 900123', '020 7946 0000', '(020) 7946-0000', '+1 415 555 0100', '+44 7700 900123 ext 4567']) expect(detailProblems(details({ phone }))).toEqual({})
    for (const postcode of ['SW3 1AA', 'sw3 1aa', 'sw31aa', 'W1A 1AA', 'EC1A 1BB', 'M1 1AE', ' SW1A 2AA ']) expect(detailProblems(details({ postcode }))).toEqual({})
  })
  it('names a number that cannot be right', () => {
    for (const phone of ['12345', 'abc', '123456789012345678901', '+44 7700 900123 4567 8901 2345']) expect(detailProblems(details({ phone })).phone).toMatch(/doesn't look right/)
  })
  it('names a postcode that cannot be right', () => {
    for (const postcode of ['ZZZ', '12345', 'SW3 1AAA', 'hello world', 'SW3']) expect(detailProblems(details({ postcode })).postcode).toMatch(/doesn't look right/)
  })
  it('leaves empty fields to be asked for, and does not judge the postcode of a saved address', () => {
    expect(detailProblems(details({ phone: '', postcode: '' }))).toEqual({})
    expect(detailProblems(details({ postcode: 'ZZZ', savedAddressId: 'a1' }))).toEqual({})
  })
})

const saved = (changes = {}) => ({ id: 'a1', label: 'Home', address_line_1: '12 Edith Road', address_line_2: 'West Drayton', city: 'London', postcode: 'UB7 7LG', entry_instructions: 'Ring twice', is_default: false, ...changes })

describe('the address a returning client is offered straight away', () => {
  it('is the one marked as their default, in whatever order they come', () => {
    const other = saved({ id: 'a2', label: 'Saved address' })
    const home = saved({ id: 'a1', is_default: true })
    expect(usualAddress([other, home])).toBe(home)
    expect(usualAddress([home, other])).toBe(home)
  })
  it('is their only address when none is marked', () => {
    const only = saved()
    expect(usualAddress([only])).toBe(only)
  })
  it('is nothing when there are several and none is marked, or none at all', () => {
    expect(usualAddress([saved(), saved({ id: 'a2' })])).toBeNull()
    expect(usualAddress([])).toBeNull()
  })
})

describe('the address boxes on the details screen', () => {
  it('a saved address fills them, and what it does not have is left empty', () => {
    expect(addressFields(saved())).toEqual({ address_line_1: '12 Edith Road', address_line_2: 'West Drayton', city: 'London', postcode: 'UB7 7LG', entry_instructions: 'Ring twice' })
    expect(addressFields(saved({ address_line_2: null, entry_instructions: null }))).toMatchObject({ address_line_2: '', entry_instructions: '' })
  })
  it('start empty, with London as the city, and can be put back to that', () => {
    expect(blankAddressFields()).toEqual({ address_line_1: '', address_line_2: '', city: 'London', postcode: '', entry_instructions: '' })
  })
  it('count as typed once anything but the city is in them', () => {
    expect(addressTyped(blankAddressFields())).toBe(false)
    expect(addressTyped({ ...blankAddressFields(), city: 'Leeds' })).toBe(false)
    expect(addressTyped({ ...blankAddressFields(), postcode: '   ' })).toBe(false)
    for (const key of ['address_line_1', 'address_line_2', 'postcode', 'entry_instructions']) expect(addressTyped({ ...blankAddressFields(), [key]: 'x' })).toBe(true)
  })
})
