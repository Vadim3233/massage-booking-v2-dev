import { describe, expect, it } from 'vitest'
import { inviteMessage, inviteWhatsappLink } from './telegramInvite.js'

const link = 'https://t.me/VadClientsBot?start=0123456789abcdef0123456789abcdef'
describe('the Telegram link message', () => {
  it('greets the client by first name, carries the link, and says it is optional and works once', () => {
    const text = inviteMessage('Dan', link)
    expect(text.startsWith('Hi Dan! ')).toBe(true)
    expect(text).toContain(`press Start:\n${link}\n`)
    expect(text).toContain('optional')
    expect(text).toContain('works once')
    expect(text.endsWith('Warm wishes,\nVad')).toBe(true)
  })
  it('still greets a client with no first name', () => {
    expect(inviteMessage('  ', link).startsWith('Hi! ')).toBe(true)
    expect(inviteMessage(undefined, link).startsWith('Hi! ')).toBe(true)
  })
})

describe('sending it on WhatsApp', () => {
  it('opens the client\'s own chat with the message ready, in a usable form for a UK number', () => {
    const text = inviteMessage('Dan', link)
    expect(inviteWhatsappLink('07700 900123', text)).toBe(`https://wa.me/447700900123?text=${encodeURIComponent(text)}`)
    expect(inviteWhatsappLink('+44 7700 900123', 'Hi')).toBe('https://wa.me/447700900123?text=Hi')
  })
  it('gives nothing when there is no phone number', () => {
    expect(inviteWhatsappLink('', 'Hi')).toBeNull()
    expect(inviteWhatsappLink(null, 'Hi')).toBeNull()
  })
})
