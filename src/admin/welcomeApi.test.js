import { describe, expect, it, vi } from 'vitest'
import { createWelcomeApi, validateWelcome } from './welcomeApi.js'

describe('the welcome message settings', () => {
  it('keeps both texts within their limits', () => {
    expect(validateWelcome({ welcome: 'Hello', about: '' })).toBe('')
    expect(validateWelcome({ welcome: 'x'.repeat(501), about: '' })).toBe('The welcome can be up to 500 characters.')
    expect(validateWelcome({ welcome: '', about: 'x'.repeat(1501) })).toBe('The about text can be up to 1500 characters.')
    expect(validateWelcome({ welcome: ' '.repeat(600), about: '' })).toBe('')
  })
  it('saves tidied text, and nothing when a box is empty', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }))
    await createWelcomeApi({ rpc }).save({ welcome: '  Hello  ', about: '   ' })
    expect(rpc).toHaveBeenCalledWith('admin_save_welcome', { p_welcome: 'Hello', p_about: null })
  })
  it('hides technical errors', async () => {
    const rpc = async () => ({ data: null, error: { message: 'permission denied for table business_settings' } })
    await expect(createWelcomeApi({ rpc }).save({ welcome: 'x', about: '' })).rejects.toThrow('Could not save. Please check your connection and try again.')
  })
})
