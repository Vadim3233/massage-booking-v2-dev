import { describe, expect, it } from 'vitest'
import { receiptEditedAfterEmail, receiptEmailState } from './receiptState.js'

const QUEUED = '2026-10-13T10:00:00+00:00'
const minutesLater = minutes => Date.parse(QUEUED) + minutes * 60 * 1000
const mail = patch => ({ status: 'pending', to: 'clara@example.test', queued_at: QUEUED, sent_at: null, attempts: 0, ...patch })

describe('what the screen may say about the email of a receipt', () => {
  it('says nothing when nothing was emailed', () => {
    expect(receiptEmailState({ email: null, emailed_at: null })).toBeNull()
  })
  it('tells apart waiting, sent, trying again, and given up', () => {
    const now = minutesLater(1)
    expect(receiptEmailState({ email: mail({}) }, now)).toMatchObject({ status: 'queued', to: 'clara@example.test' })
    expect(receiptEmailState({ email: mail({ status: 'sending', attempts: 1 }) }, now).status).toBe('queued')
    expect(receiptEmailState({ email: mail({ status: 'sent', sent_at: '2026-10-13T10:01:00+00:00', attempts: 1 }) }, now)).toMatchObject({ status: 'sent', at: '2026-10-13T10:01:00+00:00' })
    expect(receiptEmailState({ email: mail({ status: 'failed', attempts: 2 }) }, now).status).toBe('retrying')
    expect(receiptEmailState({ email: mail({ status: 'failed', attempts: 5 }) }, now).status).toBe('failed')
  })
  it('does not promise a quick send once an email has waited too long', () => {
    expect(receiptEmailState({ email: mail({}) }, minutesLater(9)).status).toBe('queued')
    expect(receiptEmailState({ email: mail({}) }, minutesLater(11)).status).toBe('stuck')
    expect(receiptEmailState({ email: mail({ status: 'sending', attempts: 1 }) }, minutesLater(30)).status).toBe('stuck')
  })
  it('treats a send cut off on its last try, which is never picked up again, as failed', () => {
    expect(receiptEmailState({ email: mail({ status: 'sending', attempts: 5 }) }, minutesLater(30)).status).toBe('failed')
    expect(receiptEmailState({ email: mail({ status: 'sending', attempts: 5 }) }, minutesLater(1)).status).toBe('queued')
  })
  it('never calls an email sent when only the fact that one was queued is left', () => {
    expect(receiptEmailState({ email: null, emailed_at: '2026-09-01T09:00:00+00:00', emailed_to: 'old@example.test' }))
      .toMatchObject({ status: 'unknown', to: 'old@example.test', at: '2026-09-01T09:00:00+00:00' })
  })
})

describe('a receipt changed after it was emailed', () => {
  it('is noticed only when the change came after the email was written', () => {
    expect(receiptEditedAfterEmail({ email: mail({}), edited_at: '2026-10-13T10:05:00+00:00' })).toBe(true)
    expect(receiptEditedAfterEmail({ email: mail({}), edited_at: '2026-10-13T09:55:00+00:00' })).toBe(false)
    expect(receiptEditedAfterEmail({ email: mail({}), edited_at: null })).toBe(false)
    expect(receiptEditedAfterEmail({ email: null, emailed_at: null, edited_at: '2026-10-13T10:05:00+00:00' })).toBe(false)
  })
})
