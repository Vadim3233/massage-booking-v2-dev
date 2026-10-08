import { describe, expect, it, vi } from 'vitest'
import { canPutBack, createSeriesApi, dayName, describeRepeat, SKIP_LABELS, validReminderDays } from './seriesApi.js'

describe('describing a repeat', () => {
  it('says the weekday, time and length', () => {
    expect(describeRepeat({ weekday: 4, start_minutes: 600, treatment_duration_minutes: 90 })).toBe('Every Thursday at 10:00 · 90 min')
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
  it('shows server sentences written for the Admin and hides everything else', async () => {
    await expect(createSeriesApi(client({ data: null, error: { message: 'That session is already booked. Cancel the booking instead.' } })).skip('s1', '2031-01-02'))
      .rejects.toThrow('That session is already booked. Cancel the booking instead.')
    await expect(createSeriesApi(client({ data: null, error: { message: 'relation "booking_series" does not exist' } })).list('c1'))
      .rejects.toThrow('Could not complete that. Please check your connection and try again.')
  })
})
