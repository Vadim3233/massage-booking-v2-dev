import { describe, expect, it } from 'vitest'
import { addressFields, addressTyped, blankAddressFields, contactComplete, detailProblems, emptyDetails, migrateDetails, restoreDraft, usualAddress, validDetails, withPostcode } from './bookingDraft.js'

const details = (changes = {}) => ({ first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test', phone: '07700 900123', address: '1 Test Road, London SW3 1AA', savedAddressId: '', ...changes })

describe('what is plainly wrong with the details a client typed', () => {
  it('accepts ordinary UK and international numbers', () => {
    for (const phone of ['07700 900123', '+44 7700 900123', '020 7946 0000', '(020) 7946-0000', '+1 415 555 0100', '+44 7700 900123 ext 4567']) expect(detailProblems(details({ phone }))).toEqual({})
  })
  it('names a number that cannot be right', () => {
    for (const phone of ['12345', 'abc', '123456789012345678901', '+44 7700 900123 4567 8901 2345']) expect(detailProblems(details({ phone })).phone).toMatch(/doesn't look right/)
  })
  it('does not judge an address: it is one text, and only the client knows whether it is complete', () => {
    for (const address of ['', 'Flat 2, 5 Road', 'ZZZ', '12345', 'hello world', '10 High Street, London, no postcode here']) expect(detailProblems(details({ address }))).toEqual({})
  })
  it('leaves empty fields to be asked for', () => {
    expect(detailProblems(details({ phone: '', address: '' }))).toEqual({})
  })
})

const saved = (changes = {}) => ({ id: 'a1', label: 'Home', address: '12 Edith Road, West Drayton, London, UB7 7LG', entry_instructions: 'Ring twice', is_default: false, ...changes })

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
    expect(addressFields(saved())).toEqual({ address: '12 Edith Road, West Drayton, London, UB7 7LG', postcode: 'UB7 7LG', entry_instructions: 'Ring twice' })
    expect(addressFields(saved({ entry_instructions: null }))).toMatchObject({ entry_instructions: '' })
  })
  it('start empty, and can be put back to that', () => {
    expect(blankAddressFields()).toEqual({ address: '', postcode: '', entry_instructions: '' })
    expect(emptyDetails).toEqual({ first_name: '', last_name: '', email: '', phone: '', savedAddressId: '', address: '', postcode: '', entry_instructions: '' })
  })
  it('count as typed once anything is in them', () => {
    expect(addressTyped(blankAddressFields())).toBe(false)
    expect(addressTyped({ ...blankAddressFields(), address: '   ' })).toBe(false)
    for (const key of ['address', 'entry_instructions']) expect(addressTyped({ ...blankAddressFields(), [key]: 'x' })).toBe(true)
  })
  it('make the details complete only with an address, a saved one or a typed one', () => {
    expect(validDetails(details())).toBe(true)
    expect(validDetails(details({ address: '   ' }))).toBe(false)
    expect(validDetails(details({ address: '', savedAddressId: 'a1' }))).toBe(true)
  })
})

describe('a draft kept from before the address was one box', () => {
  const old = { first_name: 'Ada', address_line_1: '1 Old Road', address_line_2: 'Flat 2', city: 'London', postcode: 'sw3 1aa', entry_instructions: 'Ring twice' }
  it('has its four parts put together, so nothing that was typed is lost', () => {
    expect(migrateDetails(old)).toEqual({ ...emptyDetails, first_name: 'Ada', address: '1 Old Road, Flat 2, London, sw3 1aa', entry_instructions: 'Ring twice' })
  })
  it('does not count the city alone (it started as London) as an address', () => {
    expect(migrateDetails({ ...old, address_line_1: '', address_line_2: '', postcode: '' }).address).toBe('')
  })
  it('leaves a draft that already has the one text as it is, and fills in what an old one never had', () => {
    expect(migrateDetails({ first_name: 'Ada', address: 'Kept as typed' })).toEqual({ ...emptyDetails, first_name: 'Ada', address: 'Kept as typed' })
    expect(migrateDetails(undefined)).toEqual(emptyDetails)
  })
  it('is what a restored draft is made of', () => {
    const storage = { getItem: () => JSON.stringify({ version: 1, draft: { sessions: [], details: old } }) }
    expect(restoreDraft(storage).details.address).toBe('1 Old Road, Flat 2, London, sw3 1aa')
  })
})

describe("when a returning client's details can be shown locked", () => {
  it('is when the name and the phone are all there', () => {
    expect(contactComplete(details())).toBe(true)
    expect(contactComplete(details({ phone: '+44 7700 900123' }))).toBe(true)
  })
  it('is not when any of the three is missing or only spaces, so the boxes stay open to fill in', () => {
    for (const key of ['first_name', 'last_name', 'phone']) {
      expect(contactComplete(details({ [key]: '' }))).toBe(false)
      expect(contactComplete(details({ [key]: '   ' }))).toBe(false)
      expect(contactComplete(details({ [key]: undefined }))).toBe(false)
    }
  })
  it('does not depend on the address or the email', () => {
    expect(contactComplete(details({ address_line_1: '', postcode: '', email: '' }))).toBe(true)
  })
})

describe('the postcode box', () => {
  it('adds the postcode to the end of the address', () => {
    expect(withPostcode('12 Cheyne Walk\nLondon', 'sw3 5lr')).toEqual({ address: '12 Cheyne Walk, London, SW3 5LR', postcode: 'SW3 5LR' })
  })
  it('does not add it twice', () => {
    expect(withPostcode('12 Cheyne Walk, London SW3 5LR', 'SW35LR')).toEqual({ address: '12 Cheyne Walk, London SW3 5LR', postcode: 'SW3 5LR' })
  })
  it('takes a postcode written in the address when the box is left empty', () => {
    expect(withPostcode('12 Cheyne Walk, SW3 5LR', '')).toEqual({ address: '12 Cheyne Walk, SW3 5LR', postcode: 'SW3 5LR' })
  })
  it('asks for a postcode when there is none, or the box holds something else', () => {
    expect(withPostcode('12 Cheyne Walk', '').problem).toBe('Please enter your postcode, for example SW3 4LP.')
    expect(withPostcode('12 Cheyne Walk', 'Chelsea').problem).toBe('Please enter your postcode, for example SW3 4LP.')
    expect(withPostcode('12 Cheyne Walk', 'London SW3 5LR').problem).toBe('Please enter your postcode, for example SW3 4LP.')
  })
  it('points out an address with a different postcode in it', () => {
    expect(withPostcode('1 Park Lane, W1K 1PN', 'SW3 5LR').problem).toBe('Your address says W1K 1PN, but the postcode box says SW3 5LR. Please make them the same.')
  })
})
