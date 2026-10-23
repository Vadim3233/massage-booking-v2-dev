import { describe, expect, it } from 'vitest'
import { clientContactLinks } from './contactLinks.js'
import { addressTyped, createClientsApi, fullName, validateAddress, validateClient, validateOptionalAddress } from './clientsApi.js'

describe('checking a client before saving', () => {
  it('needs only a name: a phone and an email are optional', () => {
    expect(validateClient({ first_name: 'Ana' })).toBe('')
    expect(validateClient({ first_name: 'Ana', last_name: '', phone: '', email: ' ' })).toBe('')
    expect(validateClient({ first_name: 'Ana', email: 'ana@example.test' })).toBe('')
    expect(validateClient({ first_name: 'Ana', phone: '07700 900123' })).toBe('')
    expect(validateClient({ first_name: ' ', email: 'ana@example.test' })).toBe('Enter a first name.')
    expect(validateClient({})).toBe('Enter a first name.')
  })
  it('catches an email or phone that cannot be right', () => {
    expect(validateClient({ first_name: 'Ana', email: 'ana-at-example' })).toBe('That email address does not look right.')
    expect(validateClient({ first_name: 'Ana', phone: '123' })).toBe('That phone number does not look right.')
    expect(validateClient({ first_name: 'Ana', phone: '+44 (0)7700 900123 ext 4' })).toBe('')
  })
  it('needs only an address, as one text', () => {
    expect(validateAddress({ address: '1 Road, London SW1A 1AA' })).toBe('')
    expect(validateAddress({ address: 'Flat 2\n1 Road\nLondon' })).toBe('')
    expect(validateAddress({ address: '' })).toBe('Enter the address.')
    expect(validateAddress({ address: '   ' })).toBe('Enter the address.')
    expect(validateAddress({})).toBe('Enter the address.')
  })
  it('treats an address given with a new client as optional', () => {
    expect(addressTyped({ address: '', entry_instructions: '' })).toBe(false)
    expect(addressTyped({ address: '  ' })).toBe(false)
    expect(validateOptionalAddress({ address: ' ', entry_instructions: '' })).toBe('')
    expect(validateOptionalAddress({ address: '1 Road, London SW1A 1AA' })).toBe('')
    expect(validateOptionalAddress({ address: '1 Road', entry_instructions: 'Ring twice' })).toBe('')
  })
  it('does not accept entry instructions with no address to belong to', () => {
    expect(addressTyped({ address: '', entry_instructions: 'Ring twice' })).toBe(true)
    expect(validateOptionalAddress({ address: '', entry_instructions: 'Ring twice' })).toBe('Enter the address these instructions are for, or clear them.')
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

describe('saving an address', () => {
  it('sends it as one text without the padding, with a blank label or way in as nothing', async () => {
    const calls = []
    const api = createClientsApi({ from: table => ({
      insert: async row => { calls.push([table, 'insert', row]); return { data: null, error: null } },
      update: row => ({ eq: async (column, id) => { calls.push([table, 'update', row, column, id]); return { data: null, error: null } } }),
    }) })
    await api.addAddress('c1', { label: ' Home ', address: '  7 Office Lane\nLondon  ', entry_instructions: '  ' })
    await api.updateAddress('a1', { label: '', address: ' 8 Road ', entry_instructions: ' Ring ' })
    expect(calls).toEqual([
      ['client_addresses', 'insert', { client_id: 'c1', label: 'Home', address: '7 Office Lane\nLondon', entry_instructions: null }],
      ['client_addresses', 'update', { label: null, address: '8 Road', entry_instructions: 'Ring' }, 'id', 'a1'],
    ])
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

describe('deleting a client', () => {
  it('asks the database about the client, and deletes with a request key', async () => {
    const calls = []
    const api = createClientsApi({ rpc: async (name, args) => { calls.push([name, args]); return { data: { found: true }, error: null } } })
    await api.deleteCheck('c1')
    await api.deleteClient('c1', 'key-1', { addresses: 2, notes: 1, waitlist: 0, login: 'added' })
    expect(calls).toEqual([
      ['admin_client_delete_check', { p_client_id: 'c1' }],
      ['admin_delete_client', { p_client_id: 'c1', p_request_id: 'key-1', p_expected: { addresses: 2, notes: 1, waitlist: 0, login: 'added' } }],
    ])
  })
  it('keeps the plain refusals written by the server', async () => {
    const failing = message => createClientsApi({ rpc: async () => ({ error: { message } }) })
    for (const message of [
      'This client has bookings, so they cannot be deleted. Bookings, payments and receipts are your records.',
      'This client has a repeating booking, so they cannot be deleted.',
      'Someone is in the middle of booking right now. Try again in a few minutes.',
      'This client is signed in as an Admin, so they cannot be deleted here.',
      'That client is no longer there. They may already have been deleted or combined.',
      'Something changed while you were deciding. Please look at the question again.',
    ]) await expect(failing(message).deleteClient('c1', 'key-1', {})).rejects.toThrow(message)
  })
  it('hides anything the server did not write for her', async () => {
    const failing = message => createClientsApi({ rpc: async () => ({ error: { message } }) })
    await expect(failing('Admin authorization required').deleteClient('c1', 'key-1', {})).rejects.toThrow('Could not complete that.')
    await expect(failing('update or delete on table "clients" violates foreign key constraint "bookings_client_id_fkey" on table "bookings"').deleteClient('c1', 'key-1', {})).rejects.toThrow('Could not complete that.')
    await expect(failing('permission denied for table users').deleteCheck('c1')).rejects.toThrow('Could not complete that.')
  })
})

describe('the Telegram link for a client', () => {
  const asked = []
  const fake = (data, error = null) => ({ rpc: (name, args) => { asked.push([name, args]); return Promise.resolve({ data, error }) } })
  it('asks the database whether a client has linked, and for a one-time code', async () => {
    expect(await createClientsApi(fake({ linked: true })).telegramStatus('c1')).toEqual({ linked: true })
    expect(await createClientsApi(fake('abc')).createTelegramLink('c1')).toBe('abc')
    expect(asked).toEqual([['admin_client_telegram_status', { p_client_id: 'c1' }], ['admin_create_client_telegram_link', { p_client_id: 'c1' }]])
  })
  it('says plainly when to wait, and nothing technical otherwise', async () => {
    await expect(createClientsApi(fake(null, { message: 'Please wait a little before asking again.' })).createTelegramLink('c1')).rejects.toThrow('Please wait a little before asking again.')
    await expect(createClientsApi(fake(null, { message: 'permission denied for table client_telegram_tokens' })).createTelegramLink('c1')).rejects.toThrow('Could not complete that. Please check your connection and try again.')
  })
})

describe('the bank transfers a client has not yet paid', () => {
  it('asks only for the unpaid bank transfers of that one client, oldest first', async () => {
    const calls = []
    const chain = new Proxy({}, { get: (_, name) => name === 'then' ? resolve => resolve({ data: [{ id: 'b1' }], error: null }) : (...args) => { calls.push([name, ...args]); return chain } })
    const rows = await createClientsApi({ from: table => { calls.push(['from', table]); return chain } }).outstandingPayments('c1')
    expect(rows).toEqual([{ id: 'b1' }])
    expect(calls).toContainEqual(['from', 'bookings'])
    expect(calls).toContainEqual(['eq', 'client_id', 'c1'])
    expect(calls).toContainEqual(['eq', 'booking_payments.method', 'bank_transfer'])
    expect(calls).toContainEqual(['in', 'booking_payments.status', ['awaiting_transfer', 'awaiting_verification']])
  })
})
