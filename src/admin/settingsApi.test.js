import { describe, expect, it } from 'vitest'
import { createSettingsApi, RULE_FIELDS, validateBank, validateRules } from './settingsApi.js'

const rules = (overrides = {}) => ({ booking_horizon_days: '40', minimum_notice_hours: '2', free_cancellation_hours: '24', grace_minutes: '60', new_client_booking_limit: '1', returning_client_booking_limit: '5', ...overrides })

describe('checking the booking rules before saving', () => {
  it('accepts the usual values', () => { expect(validateRules(rules())).toBe('') })
  it('keeps every rule inside its range, in plain words', () => {
    expect(validateRules(rules({ booking_horizon_days: '0' }))).toContain('choose a number from 1 to 365')
    expect(validateRules(rules({ minimum_notice_hours: '73' }))).toContain('choose a number from 0 to 72')
    expect(validateRules(rules({ free_cancellation_hours: '169' }))).toContain('choose a number from 0 to 168')
    expect(validateRules(rules({ grace_minutes: '241' }))).toContain('choose a number from 0 to 240')
    expect(validateRules(rules({ new_client_booking_limit: '11' }))).toContain('choose a number from 1 to 10')
  })
  it('wants whole numbers only', () => {
    for (const bad of ['', 'abc', '2.5', '-1', '1e2']) expect(validateRules(rules({ minimum_notice_hours: bad }))).toContain('enter a whole number')
  })
  it('will not allow a returning client fewer bookings than a new one', () => {
    expect(validateRules(rules({ new_client_booking_limit: '3', returning_client_booking_limit: '2' }))).toBe('A returning client should be allowed at least as many bookings as a new client.')
    expect(validateRules(rules({ new_client_booking_limit: '3', returning_client_booking_limit: '3' }))).toBe('')
  })
  it('describes every rule the database knows', () => {
    expect(RULE_FIELDS.map(field => field.key).sort()).toEqual(['booking_horizon_days', 'free_cancellation_hours', 'grace_minutes', 'minimum_notice_hours', 'new_client_booking_limit', 'returning_client_booking_limit'])
  })
})

describe('checking bank details before saving', () => {
  it('needs a name, a six-digit sort code and an eight-digit account number', () => {
    expect(validateBank({ account_name: 'Vad', sort_code: '12-34-56', account_number: '12345678' })).toBe('')
    expect(validateBank({ account_name: ' ', sort_code: '12-34-56', account_number: '12345678' })).toBe('Enter the name on the account.')
    expect(validateBank({ account_name: 'Vad', sort_code: '1234', account_number: '12345678' })).toContain('six digits')
    expect(validateBank({ account_name: 'Vad', sort_code: '123456', account_number: '1234567' })).toContain('eight digits')
  })
})

describe('what is sent and shown', () => {
  it('sends the rules as numbers', async () => {
    const calls = []
    await createSettingsApi({ rpc: async (name, args) => { calls.push([name, args]); return { data: null, error: null } } }).saveRules(rules({ minimum_notice_hours: '4' }))
    expect(calls[0]).toEqual(['admin_save_booking_rules', { p_rules: { booking_horizon_days: 40, minimum_notice_hours: 4, free_cancellation_hours: 24, grace_minutes: 60, new_client_booking_limit: 1, returning_client_booking_limit: 5 } }])
  })
  it('shows the kind messages and hides technical ones', async () => {
    const failing = message => createSettingsApi({ rpc: async () => ({ error: { message } }) })
    await expect(failing('Notice must be between 0 and 72 hours').saveRules(rules())).rejects.toThrow('Notice must be between 0 and 72 hours')
    await expect(failing('permission denied for table business_settings').saveRules(rules())).rejects.toThrow('Could not save. Please check your connection and try again.')
  })
})
