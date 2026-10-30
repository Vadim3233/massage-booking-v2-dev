import { describe, expect, it } from 'vitest'
import { MAX_ADDRESS, areaForPostcode, needsPostcodeNote, postcodeCheck, postcodeOf, shortWhere, tidyAddress } from './address.js'

describe('tidying an address as the database does', () => {
  it('turns line breaks into commas', () => {
    expect(tidyAddress('10 High Street\nLondon\nSW1A 1AA')).toBe('10 High Street, London, SW1A 1AA')
    expect(tidyAddress('Flat 2\r\n5 Test Road\r\n\r\nLondon')).toBe('Flat 2, 5 Test Road, London')
  })
  it('collapses spaces and doubled commas, and trims the ends', () => {
    expect(tidyAddress('  10 High   Street ,, London ,  ')).toBe('10 High Street, London')
    expect(tidyAddress('Flat 2,\nLondon')).toBe('Flat 2, London')
    expect(tidyAddress('\t12 Test Road\t')).toBe('12 Test Road')
  })
  it('leaves a tidy address alone and gives nothing for nothing', () => {
    expect(tidyAddress('10 High Street, London SW1A 1AA')).toBe('10 High Street, London SW1A 1AA')
    expect(tidyAddress('   ')).toBe('')
    expect(tidyAddress(' , , ')).toBe('')
    expect(tidyAddress(null)).toBe('')
    expect(tidyAddress(undefined)).toBe('')
  })
  it('allows 400 characters', () => { expect(MAX_ADDRESS).toBe(400) })
})

describe('the postcode inside an address', () => {
  it('is found however it is written, and set out as postcodes are', () => {
    expect(postcodeOf('10 High Street, London SW1A 1AA')).toBe('SW1A 1AA')
    expect(postcodeOf('10 High Street, London, sw31aa')).toBe('SW3 1AA')
    expect(postcodeOf('Flat 2, 5 Test Road, Manchester M1 1AE')).toBe('M1 1AE')
    expect(postcodeOf('1 Road, EC1A 1BB, London')).toBe('EC1A 1BB')
    expect(postcodeOf('Flat 2\n5 Test Road\nW1A 0AX')).toBe('W1A 0AX')
  })
  it('is nothing when there is none', () => {
    for (const address of ['10 High Street, London', '', null, undefined, '12345', 'Flat 22, 33 Road']) expect(postcodeOf(address)).toBe('')
  })
  it('is not mistaken for a house number and a street', () => {
    expect(postcodeOf('12 Ab1 Road')).toBe('')
  })
})

describe('where an appointment is, for a card', () => {
  it('is the postcode, or else the last part of the address', () => {
    expect(shortWhere('10 High Street, London SW1A 1AA')).toBe('SW1A 1AA')
    expect(shortWhere('10 High Street, Croydon')).toBe('Croydon')
    expect(shortWhere('10 High Street')).toBe('10 High Street')
    expect(shortWhere('')).toBe('')
  })
  it('is shortened when it would be long', () => {
    expect(shortWhere('1 Road, A very long place name that goes on and on')).toBe('A very long place name that…')
  })
})

describe('the note for an address with no postcode', () => {
  it('is for an address that has been typed and has none', () => {
    expect(needsPostcodeNote('10 High Street, London')).toBe(true)
    expect(needsPostcodeNote('10 High Street, London SW1A 1AA')).toBe(false)
    expect(needsPostcodeNote('')).toBe(false)
    expect(needsPostcodeNote('   ')).toBe(false)
  })
})

describe('which area a postcode is in', () => {
  const chelsea = { id: 'c', name: 'Chelsea', postcodes: ['SW10', 'SW3'] }
  const mayfair = { id: 'm', name: 'Mayfair', postcodes: ['W1'] }
  const paddington = { id: 'p', name: 'Paddington', postcodes: ['W2 1'] }
  const nottingHill = { id: 'n', name: 'Notting Hill', postcodes: ['W2', 'W11'] }
  const areas = [chelsea, mayfair, nottingHill, paddington]
  it('finds the district, and a district without its last letter', () => {
    expect(areaForPostcode(areas, 'sw3 4lp')).toBe(chelsea)
    expect(areaForPostcode(areas, '1 Park Lane, W1K 1PN')).toBe(mayfair)
  })
  it('lets a sector win over its district', () => {
    expect(areaForPostcode(areas, 'W2 1AB')).toBe(paddington)
    expect(areaForPostcode(areas, 'W2 5XX')).toBe(nottingHill)
  })
  it('finds nothing for a postcode in no area, or no postcode', () => {
    expect(areaForPostcode(areas, 'E1 4NS')).toBeNull()
    expect(areaForPostcode(areas, '1 High Street')).toBeNull()
  })
  it('tells the client what is wrong, if anything', () => {
    expect(postcodeCheck(areas, chelsea, '5 Cheyne Walk, SW3 5LR')).toBeNull()
    expect(postcodeCheck(areas, chelsea, '1 Park Lane, W1K 1PN')).toEqual({ kind: 'other', postcode: 'W1K 1PN', area: mayfair })
    expect(postcodeCheck(areas, chelsea, '1 Mile End Road, E1 4NS')).toEqual({ kind: 'outside', postcode: 'E1 4NS' })
    expect(postcodeCheck(areas, chelsea, '5 Cheyne Walk')).toEqual({ kind: 'none' })
    expect(postcodeCheck(areas, chelsea, '')).toBeNull()
  })
  it('checks nothing until the areas have postcodes', () => {
    expect(postcodeCheck([{ id: 'c', postcodes: [] }], { id: 'c' }, '1 Mile End Road, E1 4NS')).toBeNull()
  })
})
