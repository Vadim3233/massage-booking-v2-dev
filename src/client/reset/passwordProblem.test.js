import { describe, expect, it } from 'vitest'
import { passwordProblem } from './passwordProblem.js'

describe('a new password and its repeat', () => {
  it('will do when it is at least 8 characters and typed the same twice', () => {
    expect(passwordProblem('12345678', '12345678')).toBe('')
    expect(passwordProblem('a long passphrase here', 'a long passphrase here')).toBe('')
  })
  it('is too short below 8 characters, or when nothing was typed', () => {
    expect(passwordProblem('1234567', '1234567')).toBe('Please choose a password of at least 8 characters.')
    expect(passwordProblem('', '')).toBe('Please choose a password of at least 8 characters.')
    expect(passwordProblem(null, null)).toBe('Please choose a password of at least 8 characters.')
  })
  it('must be typed the same twice, and says so after the length', () => {
    expect(passwordProblem('12345678', '12345679')).toBe('The two passwords are not the same. Please type them again.')
    expect(passwordProblem('12345678', '')).toBe('The two passwords are not the same. Please type them again.')
    expect(passwordProblem('short', 'different')).toBe('Please choose a password of at least 8 characters.')
  })
  it('counts capitals as they were typed', () => {
    expect(passwordProblem('Abcdefgh', 'abcdefgh')).toBe('The two passwords are not the same. Please type them again.')
  })
})
