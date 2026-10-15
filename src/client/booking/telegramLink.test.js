import { describe, expect, it } from 'vitest'
import { cleanUsername, POLL_FOR_MS, POLL_MS, REFRESH_AFTER_MS, shouldRefresh, telegramLink } from './telegramLink.js'

const CODE = '0123456789abcdef0123456789abcdef'

describe("the clients-only bot's name", () => {
  it('accepts a username as Telegram writes it, with or without the @', () => {
    expect(cleanUsername('VadMassageBot')).toBe('VadMassageBot')
    expect(cleanUsername('@VadMassageBot')).toBe('VadMassageBot')
    expect(cleanUsername('  vad_clients_bot  ')).toBe('vad_clients_bot')
    expect(cleanUsername('Vad_bot')).toBe('Vad_bot')
    expect(cleanUsername('abcdBOT')).toBe('abcdBOT')
    // Five to 32 characters in all, and the shortest and longest both count.
    expect(cleanUsername('abbot')).toBe('abbot')
    expect(cleanUsername(`${'a'.repeat(29)}bot`)).toBe(`${'a'.repeat(29)}bot`)
  })
  it('treats anything else as not set up, so the box is not shown', () => {
    for (const value of [undefined, null, '', '   ', '@', 'bot', 'abot', 'NotABotName', 'has space bot', 'https://t.me/VadMassageBot', 'Vad-Massage-Bot', '1VadBot', '_VadBot', 'Vad.Bot', `${'a'.repeat(30)}bot`, 42, {}]) {
      expect(cleanUsername(value)).toBe('')
    }
  })
})

describe('the link that opens the bot with a code', () => {
  it('is the Telegram address with the code as the start word', () => {
    expect(telegramLink('@VadMassageBot', CODE)).toBe(`https://t.me/VadMassageBot?start=${CODE}`)
    expect(telegramLink('VadMassageBot', 'A_b-C_d-E_f-G_h-I')).toBe('https://t.me/VadMassageBot?start=A_b-C_d-E_f-G_h-I')
  })
  it('is empty without a bot, or for anything that is not a code', () => {
    expect(telegramLink('', CODE)).toBe('')
    expect(telegramLink('nonsense', CODE)).toBe('')
    for (const code of [undefined, null, '', 'short', 'a'.repeat(15), 'a'.repeat(65), 'has space in it 0123456789', 'semi;colon0123456789', 'ünïcödé0123456789abcd', '<script>0123456789abcdef', 1234567890123456, ['x']]) {
      expect(telegramLink('VadMassageBot', code)).toBe('')
    }
  })
})

describe('replacing a code that has been showing a long while', () => {
  it('is replaced after an hour, not before', () => {
    expect(REFRESH_AFTER_MS).toBe(3600000)
    expect(shouldRefresh(1000, 1000 + REFRESH_AFTER_MS - 1)).toBe(false)
    expect(shouldRefresh(1000, 1000 + REFRESH_AFTER_MS)).toBe(true)
    expect(shouldRefresh(0, Number.NaN)).toBe(false)
  })
  it('is replaced when nobody knows when it was made', () => {
    expect(shouldRefresh(undefined, 5)).toBe(true)
    expect(shouldRefresh(Number.NaN, 5)).toBe(true)
  })
  it('looks every few seconds for a few minutes while waiting for the client to press Start', () => {
    expect(POLL_MS).toBe(3000)
    expect(POLL_FOR_MS).toBe(300000)
  })
})
