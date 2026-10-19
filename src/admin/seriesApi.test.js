import { describe, expect, it, vi } from 'vitest'
import { CANCELLABLE, canPutBack, createSeriesApi, dayName, describeRepeat, SKIP_LABELS, validReminderDays } from './seriesApi.js'

describe('describing a repeat', () => {
  it('says the weekday, time and length', () => {
    expect(describeRepeat({ weekday: 4, start_minutes: 600, treatment_duration_minutes: 90 })).toBe('Every Thursday at 10:00 · 90 min')
  })
  it('says how a repeat that is not every week repeats', () => {
    const base = { weekday: 4, start_minutes: 600, treatment_duration_minutes: 90 }
    expect(describeRepeat({ ...base, pattern: 'weeks', every_weeks: 2 })).toBe('Every 2 weeks, on Thursday at 10:00 · 90 min')
    expect(describeRepeat({ ...base, pattern: 'monthly', every_weeks: 1, month_week: 1 })).toBe('Every month, on the first Thursday at 10:00 · 90 min')
    expect(describeRepeat({ ...base, pattern: 'dates', every_weeks: 1 })).toBe('On chosen dates at 10:00 · 90 min')
  })
  it('names the weekday of a date', () => {
    expect(dayName('2026-10-15')).toBe('Thursday')
    expect(dayName('2026-10-18')).toBe('Sunday')
    expect(dayName('2026-10-19')).toBe('Monday')
  })
  it('lets only skipped or clashing dates be put back', () => {
    expect(['skipped', 'clash', 'cancelled', 'moved'].map(canPutBack)).toEqual([true, true, false, false])
    expect(Object.keys(SKIP_LABELS).sort()).toEqual(['cancelled', 'clash', 'moved', 'skipped'])
  })
})

describe('the reminder window', () => {
  it('accepts 1 to 30 whole days only', () => {
    expect(['1', '7', '30', ' 14 '].map(validReminderDays)).toEqual([true, true, true, true])
    expect(['', '0', '31', '1.5', '-3', 'abc', '100'].map(validReminderDays)).toEqual([false, false, false, false, false, false, false])
  })
})

describe('commands', () => {
  const client = (result = { data: null, error: null }) => ({ rpc: vi.fn(async () => result) })
  it('sends the right commands', async () => {
    const c = client()
    const api = createSeriesApi(c)
    await api.list('c1'); await api.setStatus('s1', 'paused'); await api.skip('s1', '2031-01-02'); await api.unskip('s1', '2031-01-02')
    expect(c.rpc.mock.calls).toEqual([
      ['admin_client_series', { p_client_id: 'c1' }],
      ['admin_set_series_status', { p_series_id: 's1', p_status: 'paused' }],
      ['admin_skip_series_date', { p_series_id: 's1', p_date: '2031-01-02' }],
      ['admin_unskip_series_date', { p_series_id: 's1', p_date: '2031-01-02' }],
    ])
  })
  it('cancels some dates, or all that is upcoming, with a request key so that a retry changes nothing', async () => {
    const c = client({ data: { cancelled: 1, skipped: 1 }, error: null })
    const api = createSeriesApi(c)
    expect(await api.cancelDates('s1', ['2031-01-02', '2031-01-09'], 'r1')).toEqual({ cancelled: 1, skipped: 1 })
    await api.cancelAllUpcoming('s1', 'r2')
    await api.cancelDates('s1', ['2031-01-16'])
    await api.cancelAllUpcoming('s1')
    expect(c.rpc.mock.calls.slice(0, 2)).toEqual([
      ['admin_series_cancel_dates', { p_series_id: 's1', p_dates: ['2031-01-02', '2031-01-09'], p_request_id: 'r1' }],
      ['admin_series_cancel_all_upcoming', { p_series_id: 's1', p_request_id: 'r2' }],
    ])
    // Without a key given, each is sent with one of its own.
    expect(c.rpc.mock.calls[2][1].p_request_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(c.rpc.mock.calls[3][1].p_request_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(c.rpc.mock.calls[2][1].p_request_id).not.toBe(c.rpc.mock.calls[3][1].p_request_id)
  })
  it('only lets a booking that is still going ahead be picked for cancelling', () => {
    expect(CANCELLABLE).toEqual(['awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed'])
    expect(['completed', 'cancelled', 'no_show'].some(status => CANCELLABLE.includes(status))).toBe(false)
  })
  it('shows server sentences written for the Admin and hides everything else', async () => {
    await expect(createSeriesApi(client({ data: null, error: { message: 'That session is already booked. Cancel the booking instead.' } })).skip('s1', '2031-01-02'))
      .rejects.toThrow('That session is already booked. Cancel the booking instead.')
    await expect(createSeriesApi(client({ data: null, error: { message: "That date is not one of this repeat's dates" } })).skip('s1', '2031-01-03'))
      .rejects.toThrow("That date is not one of this repeat's dates")
    await expect(createSeriesApi(client({ data: null, error: { message: 'Only dates still to come can be cancelled' } })).cancelDates('s1', ['2020-01-01'], 'r1'))
      .rejects.toThrow('Only dates still to come can be cancelled')
    await expect(createSeriesApi(client({ data: null, error: { message: 'relation "booking_series" does not exist' } })).list('c1'))
      .rejects.toThrow('Could not complete that. Please check your connection and try again.')
  })
})
