import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EMAIL_SENDER } from './emailSender.js'

// A booking page tells the client which address to look for in their inbox. It has to be the address the emails really come from, which the setup guide
// records as the EMAIL_FROM setting. If one is changed and not the other, this fails.
describe('the sender address a booking page names', () => {
  const guide = readFileSync(new URL('../../docs/NOTIFICATIONS_SETUP.md', import.meta.url), 'utf8')
  const row = guide.split('\n').find((line) => line.startsWith('| `EMAIL_FROM`'))

  it('is a plain address, as it appears in an inbox', () => {
    expect(EMAIL_SENDER).toMatch(/^[a-z0-9._-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/)
  })

  it('is the address in the setup guide for the EMAIL_FROM setting', () => {
    expect(row, 'the EMAIL_FROM row is in docs/NOTIFICATIONS_SETUP.md').toBeDefined()
    expect(row).toContain(`<${EMAIL_SENDER}>`)
  })
})
