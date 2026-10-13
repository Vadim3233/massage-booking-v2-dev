import { describe, expect, it } from 'vitest'
import { dayInWords, defaultsFromLast, isPaidArrangement, PAST_PAYMENT_OPTIONS, pastOutcome, pastQuestion, PAYMENT_OPTIONS } from './presentation.js'

const catalogue = {
  services: [{ id: 's-massage', name: 'Massage' }, { id: 's-stretch', name: 'Assisted Stretching' }],
  areas: [{ id: 'a-chelsea', name: 'Chelsea' }, { id: 'a-fulham', name: 'Fulham' }],
  prices: [
    { service_id: 's-massage', duration_minutes: 60 }, { service_id: 's-massage', duration_minutes: 90 },
    { service_id: 's-stretch', duration_minutes: 60 },
  ],
}
const empty = (overrides = {}) => ({ serviceId: '', areaId: '', payment: 'bank_pending', start: null, sessions: [{ duration_minutes: 60, recipient_name: 'Amelia', preference_ids: [] }], ...overrides })
const last = (overrides = {}) => ({ service_area_id: 'a-fulham', booking_sessions: [{ position: 1, service_id: 's-massage', duration_minutes: 90 }], booking_payments: { method: 'cash' }, ...overrides })

describe('what a regular client usually books', () => {
  it('fills the treatment, length, area and payment from the last booking', () => {
    expect(defaultsFromLast(empty(), catalogue, last())).toEqual({
      serviceId: 's-massage', areaId: 'a-fulham', payment: 'cash_appointment',
      sessions: [{ duration_minutes: 90, recipient_name: 'Amelia', preference_ids: [] }],
    })
  })
  it('suggests Massage for a client with no history', () => {
    expect(defaultsFromLast(empty(), catalogue, null)).toEqual({ serviceId: 's-massage' })
  })
  it('never overwrites something already chosen', () => {
    const chosen = empty({ serviceId: 's-stretch', areaId: 'a-chelsea', payment: 'bank_received', start: 840 })
    expect(defaultsFromLast(chosen, catalogue, last())).toEqual({})
  })
  it('ignores a length, area or treatment that no longer exists', () => {
    const stale = last({ service_area_id: 'gone', booking_sessions: [{ position: 1, service_id: 'gone', duration_minutes: 120 }] })
    expect(defaultsFromLast(empty(), catalogue, stale)).toEqual({ serviceId: 's-massage', payment: 'cash_appointment' })
  })
  it('keeps several people as they are rather than guessing', () => {
    const group = empty({ sessions: [{ duration_minutes: 60, recipient_name: 'A' }, { duration_minutes: 60, recipient_name: 'B' }] })
    expect(defaultsFromLast(group, catalogue, last())).not.toHaveProperty('sessions')
  })
  it('uses the first session when the last booking had several', () => {
    const many = last({ booking_sessions: [{ position: 2, service_id: 's-stretch', duration_minutes: 60 }, { position: 1, service_id: 's-massage', duration_minutes: 90 }] })
    expect(defaultsFromLast(empty(), catalogue, many).serviceId).toBe('s-massage')
  })
  it('suggests the client\'s usual way of paying for an appointment that has already happened too: a regular who pays cash is "not paid yet, cash"', () => {
    expect(defaultsFromLast(empty({ past: true }), catalogue, last())).toHaveProperty('payment', 'cash_appointment')
    expect(PAST_PAYMENT_OPTIONS.map(([value]) => value)).toContain('cash_appointment')
  })
})

describe('recording an appointment that has already happened', () => {
  it('offers paid either way, or not paid yet either way, each an arrangement the database knows', () => {
    expect(PAST_PAYMENT_OPTIONS.map(([value]) => value)).toEqual(['bank_received', 'cash_received', 'bank_pending', 'cash_appointment'])
    for (const [value] of PAST_PAYMENT_OPTIONS) expect(PAYMENT_OPTIONS.map(([known]) => known)).toContain(value)
    expect(PAST_PAYMENT_OPTIONS.map(([, label]) => label)).toEqual(['Paid by bank transfer', 'Paid in cash', 'Not paid yet — bank transfer', 'Not paid yet — cash'])
  })
  it('knows which arrangements mean it has been paid', () => {
    expect(PAYMENT_OPTIONS.map(([value]) => isPaidArrangement(value))).toEqual([false, true, false, true])
    expect(isPaidArrangement(undefined)).toBe(false)
  })
  it('says plainly what will happen: paid is completed, unpaid stays confirmed, nobody is emailed', () => {
    const completed = 'It will be recorded as completed, and the client is not emailed.'
    const confirmed = 'It will be recorded as confirmed, and you can complete it once it is paid. The client is not emailed.'
    expect(pastOutcome('bank_received')).toBe(completed)
    expect(pastOutcome('cash_received')).toBe(completed)
    expect(pastOutcome('bank_pending')).toBe(confirmed)
    expect(pastOutcome('cash_appointment')).toBe(confirmed)
  })
  it('asks once more before a paid one is recorded, naming who, the day with its year, when, how much, and that it is final', () => {
    const question = pastQuestion({ who: 'Pia Past', date: '2026-10-07', start: 840, minutes: 90, total: '£105.00', payment: 'bank_received' })
    expect(question).toBe('Record this as completed and paid?\n\nPia Past\nWednesday 7 October 2026, 14:00–15:30\n£105.00, paid by bank transfer\n\nA completed appointment cannot be cancelled or changed from here, so please check the client and the day.')
    expect(pastQuestion({ who: 'Pia Past', date: '2025-01-02', start: 1380, minutes: 60, total: '£85.00', payment: 'cash_received' }))
      .toContain('Thursday 2 January 2025, 23:00–24:00\n£85.00, paid in cash')
  })
  it('names a day in words, with its year, the same everywhere', () => {
    expect(dayInWords('2026-10-07')).toBe('Wednesday 7 October 2026')
    expect(dayInWords('2026-01-01')).toBe('Thursday 1 January 2026')
    expect(dayInWords('2025-12-31')).toBe('Wednesday 31 December 2025')
  })
})
