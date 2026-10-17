import { describe, expect, it, vi } from 'vitest'

// If the HTML version could not be made, the email still goes: as the plain text it always was.
vi.mock('./emailHtml.js', () => ({ composeEmailHtml: () => { throw new Error('the page could not be made') } }))
const { createDispatcher, readConfig } = await import('./notifications.js')

describe('an email whose HTML version cannot be made', () => {
  it('is sent as plain text alone, and recorded as sent', async () => {
    const calls = []
    const completed = []
    const client = { async rpc(name, args) {
      if (name === 'claim_notification_deliveries') return { data: [{ id: 'c1', channel: 'email', audience: 'client', recipient: 'nadia@example.com', title: 'Your appointment is confirmed', body: 'Thank you.\n\nSee or change your booking: {link}', link_path: '/account' }], error: null }
      if (name === 'complete_notification_delivery') { completed.push(args); return { error: null } }
      throw new Error(`unexpected ${name}`)
    } }
    const config = readConfig({ APP_BASE_URL: 'https://booking.example.com', RESEND_API_KEY: 're_KEY', EMAIL_FROM: 'Vad <hello@example.com>', EMAIL_REPLY_TO: 'vad@example.com' })
    const result = await createDispatcher({ client, config, fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ id: 'x' }) } } }).dispatch()
    expect(result).toMatchObject({ claimed: 1, sent: 1, failed: 0 })
    expect(calls).toHaveLength(1)
    expect(calls[0].html).toBeUndefined()
    expect(calls[0]).toMatchObject({ to: ['nadia@example.com'], subject: 'Your appointment is confirmed', reply_to: 'vad@example.com', text: 'Thank you.\n\nSee or change your booking: https://booking.example.com/account' })
    expect(completed).toEqual([{ p_id: 'c1', p_ok: true, p_error: null }])
  })
})
