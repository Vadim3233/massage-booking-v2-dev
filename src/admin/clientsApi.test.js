import { describe, expect, it } from 'vitest'
import { clientContactLinks } from './contactLinks.js'
import { createClientsApi, fullName, validateAddress, validateClient } from './clientsApi.js'

describe('checking a client before saving', () => {
  it('needs a name and some way to reach them', () => {
    expect(validateClient({ first_name: 'Ana', email: 'ana@example.test' })).toBe('')
    expect(validateClient({ first_name: 'Ana', phone: '07700 900123' })).toBe('')
    expect(validateClient({ first_name: ' ', email: 'ana@example.test' })).toBe('Enter a first name.')
    expect(validateClient({ first_name: 'Ana' })).toBe('Enter a phone number or an email address.')
  })
  it('catches an email or phone that cannot be right', () => {
    expect(validateClient({ first_name: 'Ana', email: 'ana-at-example' })).toBe('That email address does not look right.')
    expect(validateClient({ first_name: 'Ana', phone: '123' })).toBe('That phone number does not look right.')
    expect(validateClient({ first_name: 'Ana', phone: '+44 (0)7700 900123 ext 4' })).toBe('')
  })
  it('needs a street, city and postcode for an address', () => {
    expect(validateAddress({ address_line_1: '1 Road', city: 'London', postcode: 'SW1A 1AA' })).toBe('')
    expect(validateAddress({ address_line_1: '1 Road', city: '', postcode: 'SW1A 1AA' })).toBe('Enter the street, city and postcode.')
  })
  it('names a client sensibly', () => {
    expect(fullName({ first_name: 'Ana', last_name: 'Silva' })).toBe('Ana Silva')
    expect(fullName({ first_name: 'Ana', last_name: '' })).toBe('Ana')
    expect(fullName(null)).toBe('Client')
  })
})

describe('contact links for a client', () => {
  it('offers only what is on record', () => {
    expect(clientContactLinks({ phone: '07700 900123', email: 'ana@example.test' }).map(link => [link.key, link.href])).toEqual([
      ['call', 'tel:07700900123'], ['whatsapp', 'https://wa.me/447700900123'], ['email', 'mailto:ana@example.test']])
    expect(clientContactLinks({ email: 'ana@example.test' }).map(link => link.key)).toEqual(['email'])
    expect(clientContactLinks({}).length).toBe(0)
  })
})

describe('what is shown when something fails', () => {
  const failing = message => createClientsApi({ rpc: async () => ({ error: { message } }), from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ error: { message } }) }) }) }) })
  it('keeps the kind messages written by the server and hides everything else', async () => {
    await expect(failing('Another client already uses this email or phone.').update('c1', {})).rejects.toThrow('Another client already uses this email or phone.')
    await expect(failing('duplicate key value violates unique constraint "clients_pkey"').update('c1', {})).rejects.toThrow('Could not complete that. Please check your connection and try again.')
    await expect(failing('permission denied for table clients').get('c1')).rejects.toThrow('Could not complete that.')
  })
})
