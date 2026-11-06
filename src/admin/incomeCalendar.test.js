import { describe, expect, it } from 'vitest'
import { calendarWeeks, dayDescription, dayShade, duration, hourSentence, monthlyRates, shortMoney, workShare } from './incomePresentation.js'

const november = Array.from({ length: 30 }, (_, index) => ({ date: `2026-11-${String(index + 1).padStart(2, '0')}`, received_gbp: 0, to_come_gbp: 0 }))

describe('the month calendar', () => {
  it('lays a month out in weeks from Monday, with empty squares around it', () => {
    const weeks = calendarWeeks(november)
    expect(weeks).toHaveLength(6)
    expect(weeks[0].slice(0, 6)).toEqual([null, null, null, null, null, null])
    expect(weeks[0][6].date).toBe('2026-11-01')
    expect(weeks[5][0].date).toBe('2026-11-30')
    expect(weeks[5].slice(1)).toEqual([null, null, null, null, null, null])
    expect(calendarWeeks([])).toEqual([])
  })
  it('shades a day against the month\'s best day', () => {
    expect(dayShade(0, 400)).toBe(0)
    expect(dayShade(90, 400)).toBe(1)
    expect(dayShade(180, 400)).toBe(2)
    expect(dayShade('400.00', 400)).toBe(3)
    expect(dayShade(50, 0)).toBe(0)
  })
  it('keeps the amount in a square short', () => {
    expect(shortMoney('433.00')).toBe('£433')
    expect(shortMoney(1000)).toBe('£1k')
    expect(shortMoney(1240)).toBe('£1.2k')
  })
  it('describes a day for a screen reader', () => {
    expect(dayDescription({ date: '2026-11-01', received_gbp: '433.00', to_come_gbp: '90.00' }, true)).toBe('Sun 1 Nov: £433.00 received, £90.00 booked, money owed')
    expect(dayDescription({ date: '2026-11-05', received_gbp: 0, to_come_gbp: 0 }, false)).toBe('Thu 5 Nov: nothing')
  })
})

describe('your hour', () => {
  const hours = { work_minutes: 660, travel_minutes: 390, earned_gbp: '1223.00', per_hour_gbp: '69.89' }
  it('puts time into words', () => {
    expect(duration(660)).toBe('11 h')
    expect(duration(390)).toBe('6 h 30 min')
    expect(duration(45)).toBe('45 min')
    expect(hourSentence(hours)).toBe('£1,223.00 over 17 h 30 min, travel included')
  })
  it('splits working time into treatment and travel', () => {
    expect(workShare(hours)).toBeCloseTo(660 / 1050)
    expect(workShare({ work_minutes: 0, travel_minutes: 0 })).toBe(0)
  })
  it('lists the months that had worked time, with their rate', () => {
    expect(monthlyRates([{ from: '2026-01-01', per_hour_gbp: '62.50' }, { from: '2026-02-01', per_hour_gbp: null }, { from: '2026-03-01', per_hour_gbp: 70 }]))
      .toEqual([{ from: '2026-01-01', name: 'January', per_hour_gbp: 62.5 }, { from: '2026-03-01', name: 'March', per_hour_gbp: 70 }])
  })
})
