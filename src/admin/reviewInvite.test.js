import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { askedWords, canAskForReview, reviewLinkProblem, reviewMessageProblem, reviewText, reviewWhatsappLink, STANDARD_REVIEW_MESSAGE } from './reviewInvite.js'

const LINK = 'https://g.page/r/CU-Ccr2ldxfKEBM/review'
const booking = (overrides = {}) => ({ booking_status: 'completed', date: '2026-11-10', start_minutes: 1080, treatment_duration_minutes: 90, booking_payments: { status: 'paid' }, ...overrides })

describe('the review message', () => {
  it('greets the client by first name, ends with the link and "Warm wishes, Vadim", and never says "yesterday"', () => {
    expect(reviewText('', 'Sarah', LINK)).toBe(`Hi Sarah! I hope you enjoyed our last session and you're still feeling the benefit of it. If you have a minute, a short Google review would mean a lot to me. It really helps other people find me:\n${LINK}\n\nWarm wishes,\nVadim`)
    expect(reviewText('', 'Sarah', LINK)).not.toMatch(/yesterday/i)
  })
  it('says "Hi!" when no first name is saved', () => {
    expect(reviewText('', '  ', LINK)).toMatch(/^Hi! I hope/)
  })
  it('uses the Admin\'s own wording, with both blanks', () => {
    expect(reviewText('Thanks {name}, please review me: {link}', 'Ana', LINK)).toBe(`Thanks Ana, please review me: ${LINK}`)
  })
  it('is the same standard wording the automatic message uses in the database', () => {
    const sql = readFileSync(new URL('../../supabase/migrations/20261208100000_google_review_invites.sql', import.meta.url), 'utf8')
    const quoted = sql.match(/select E'(Hi \{name\}![\s\S]*?Vadim)'\n/)[1]
    expect(quoted.replaceAll("''", "'").replaceAll('\\n', '\n')).toBe(STANDARD_REVIEW_MESSAGE)
  })
  it('refuses a wording without the link, with other blanks, or too long, as the database does', () => {
    expect(reviewMessageProblem(STANDARD_REVIEW_MESSAGE)).toBe('')
    expect(reviewMessageProblem('')).toBe('')
    expect(reviewMessageProblem('Hi {name}!')).toMatch(/needs the \{link\}/)
    expect(reviewMessageProblem('Hi {date} {link}')).toMatch(/Only the blanks/)
    expect(reviewMessageProblem(`{link}${'x'.repeat(1000)}`)).toMatch(/up to 1000/)
  })
  it('takes only an https link with no spaces', () => {
    expect(reviewLinkProblem(LINK)).toBe('')
    expect(reviewLinkProblem('')).toBe('')
    for (const bad of ['http://g.page/r/x', 'g.page/r/x', 'https://g.page/r x', 'javascript:alert(1)']) expect(reviewLinkProblem(bad)).not.toBe('')
  })
  it('opens the client\'s WhatsApp chat with the message, or nothing without a phone', () => {
    expect(reviewWhatsappLink('07700 900123', 'Hi Sarah!')).toBe('https://wa.me/447700900123?text=Hi%20Sarah!')
    expect(reviewWhatsappLink('', 'Hi')).toBeNull()
  })
})

describe('when to ask', () => {
  const now = new Date('2026-11-12T12:00:00Z')
  it('asks after a paid session that is over', () => {
    expect(canAskForReview(booking(), now)).toBe(true)
    expect(canAskForReview(booking({ booking_status: 'confirmed' }), now)).toBe(true)
    expect(canAskForReview(booking({ booking_payments: [{ status: 'paid' }] }), now)).toBe(true)
  })
  it('waits for the money, and never asks about a session that did not happen', () => {
    for (const status of ['awaiting_transfer', 'approved', 'refunded', undefined]) expect(canAskForReview(booking({ booking_payments: { status } }), now)).toBe(false)
    for (const status of ['cancelled', 'no_show', 'awaiting_transfer']) expect(canAskForReview(booking({ booking_status: status }), now)).toBe(false)
  })
  it('waits until the session has ended, London time', () => {
    // 12:00 UTC is 12:00 in London in November: a 10:30–11:30 session is over, an 11:30–12:30 one is not.
    expect(canAskForReview(booking({ date: '2026-11-12', start_minutes: 630, treatment_duration_minutes: 60 }), now)).toBe(true)
    expect(canAskForReview(booking({ date: '2026-11-12', start_minutes: 690, treatment_duration_minutes: 60 }), now)).toBe(false)
    expect(canAskForReview(booking({ date: '2026-11-13' }), now)).toBe(false)
  })
  it('says when and how a client was asked', () => {
    expect(askedWords({ asked_at: '2026-11-12T10:00:00Z', channel: 'whatsapp' })).toBe('Review asked · 12 Nov 2026 · by WhatsApp')
    expect(askedWords({ asked_at: '2026-11-12T10:00:00Z', channel: 'automatic' })).toBe('Review asked · 12 Nov 2026 · by email')
    expect(askedWords(null)).toBe('')
  })
})
