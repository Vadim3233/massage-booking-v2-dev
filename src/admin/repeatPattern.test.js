import { describe, expect, it } from 'vitest'
import {
  addMonths, choiceChange, choiceValue, chosenDates, describeDraftRepeat, describeRepeat, emptyRepeat, monthGrid, monthTitle, monthWeek, monthlyWords,
  repeatChoices, repeatFor, repeatProblem, repeatRequest,
} from './repeatPattern.js'

// 2027-03-04 is a Thursday: the first Thursday of March.
const FIRST = '2027-03-04'
const on = change => ({ ...emptyRepeat, on: true, ...change })

describe('which weekday of its month a day is', () => {
  it('counts the first to the fourth, and calls a fifth the last', () => {
    expect([1, 7, 8, 14, 15, 21, 22, 28, 29, 31].map(day => monthWeek(`2027-03-${String(day).padStart(2, '0')}`))).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5])
    expect(monthlyWords('Thursday', 1)).toBe('the first Thursday')
    expect(monthlyWords('Thursday', 4)).toBe('the fourth Thursday')
    expect(monthlyWords('Thursday', 5)).toBe('the last Thursday')
  })
})

describe('the ways to repeat', () => {
  it('names them for the weekday of the first booking', () => {
    const choices = repeatChoices(FIRST)
    expect(choices.map(choice => choice.value)).toEqual(['weeks:1', 'weeks:2', 'weeks:3', 'weeks:4', 'monthly', 'dates'])
    expect(choices.map(choice => choice.short)).toEqual(['Every week', 'Every 2 weeks', 'Every 3 weeks', 'Every 4 weeks', 'Every month', 'Dates I choose'])
    expect(choices.map(choice => choice.long)).toEqual(['Every Thursday', 'Every 2 weeks, on Thursday', 'Every 3 weeks, on Thursday', 'Every 4 weeks, on Thursday',
      'Every month, on the first Thursday', 'On the dates you choose, one by one'])
    expect(repeatChoices('2027-04-29')[4].long).toBe('Every month, on the last Thursday')
  })
  it('turns a choice into the repeat and back', () => {
    expect(choiceValue(emptyRepeat)).toBe('weeks:1')
    expect(choiceValue(on({ kind: 'weeks', every: 3 }))).toBe('weeks:3')
    expect(choiceValue(on({ kind: 'monthly' }))).toBe('monthly')
    expect(choiceValue(on({ kind: 'dates' }))).toBe('dates')
    expect(choiceChange('weeks:4')).toEqual({ kind: 'weeks', every: 4 })
    expect(choiceChange('monthly')).toEqual({ kind: 'monthly', every: 1 })
    expect(choiceChange('dates')).toEqual({ kind: 'dates', every: 1 })
  })
})

describe('the dates chosen one by one', () => {
  it('keeps only days after the first booking and within three years, once each, in order', () => {
    const repeat = on({ kind: 'dates', dates: ['2027-04-01', FIRST, '2027-03-11', '2027-03-11', '2027-03-01', '2031-01-01'] })
    expect(chosenDates(repeat, FIRST)).toEqual(['2027-03-11', '2027-04-01'])
    expect(chosenDates(on({ kind: 'dates' }), FIRST)).toEqual([])
  })
  it('drops the ones that are no longer after the first booking when it moves later, and switches off for an unusual time', () => {
    const repeat = on({ kind: 'dates', dates: ['2027-03-11', '2027-03-18', '2027-04-01'] })
    expect(repeatFor(repeat, '2027-03-15')).toMatchObject({ on: true, dates: ['2027-03-18', '2027-04-01'] })
    expect(repeatFor(repeat, FIRST, true)).toMatchObject({ on: false, dates: ['2027-03-11', '2027-03-18', '2027-04-01'] })
    expect(repeatFor(on({ kind: 'weeks', every: 2, endDate: '2027-06-01' }), FIRST)).toEqual(on({ kind: 'weeks', every: 2, endDate: '2027-06-01' }))
  })
  it('asks for at least one date when the repeat is on chosen dates', () => {
    expect(repeatProblem(on({ kind: 'dates' }), FIRST)).toMatch(/Choose the dates it repeats on/)
    expect(repeatProblem(on({ kind: 'dates', dates: ['2027-03-11'] }), FIRST)).toBe('')
    expect(repeatProblem(on({ kind: 'dates', dates: [FIRST] }), FIRST)).toMatch(/Choose the dates/)
    expect(repeatProblem(on({ kind: 'weeks' }), FIRST)).toBe('')
    expect(repeatProblem(on({ kind: 'monthly' }), FIRST)).toBe('')
  })
})

describe('what the database is told', () => {
  it('sends nothing about the pattern for a plain weekly repeat, as it always did', () => {
    expect(repeatRequest(on(), FIRST)).toEqual({ endDate: null, pattern: null })
    expect(repeatRequest(on({ endDate: '2027-06-01' }), FIRST)).toEqual({ endDate: '2027-06-01', pattern: null })
  })
  it('sends the gap in weeks, or monthly, with the end date', () => {
    expect(repeatRequest(on({ every: 2 }), FIRST)).toEqual({ endDate: null, pattern: { kind: 'weeks', every_weeks: 2 } })
    expect(repeatRequest(on({ every: 4, endDate: '2027-09-01' }), FIRST)).toEqual({ endDate: '2027-09-01', pattern: { kind: 'weeks', every_weeks: 4 } })
    expect(repeatRequest(on({ kind: 'monthly', endDate: '2027-12-01' }), FIRST)).toEqual({ endDate: '2027-12-01', pattern: { kind: 'monthly' } })
  })
  it('sends the chosen dates, sorted, with no end date (an end date typed before switching is not sent)', () => {
    expect(repeatRequest(on({ kind: 'dates', dates: ['2027-04-01', '2027-03-11'], endDate: '2027-09-01' }), FIRST)).toEqual({ endDate: null, pattern: { kind: 'dates', dates: ['2027-03-11', '2027-04-01'] } })
  })
})

describe('putting a repeat into words', () => {
  it('describes the one being set up', () => {
    expect(describeDraftRepeat(on(), FIRST)).toBe('Repeats every Thursday, with no end date.')
    expect(describeDraftRepeat(on({ endDate: '2027-06-03' }), FIRST)).toBe('Repeats every Thursday until Thu, 3 Jun 2027.')
    expect(describeDraftRepeat(on({ every: 2 }), FIRST)).toBe('Repeats every 2 weeks, on Thursday, with no end date.')
    expect(describeDraftRepeat(on({ kind: 'monthly' }), FIRST)).toBe('Repeats on the first Thursday of every month, with no end date.')
    expect(describeDraftRepeat(on({ kind: 'monthly', endDate: '2027-12-02' }), '2027-04-29')).toBe('Repeats on the last Thursday of every month until Thu, 2 Dec 2027.')
    expect(describeDraftRepeat(on({ kind: 'dates' }), FIRST)).toBe('Repeats on dates you choose.')
    expect(describeDraftRepeat(on({ kind: 'dates', dates: ['2027-03-11'] }), FIRST)).toBe('Repeats on one more date: Thu 11 Mar.')
    expect(describeDraftRepeat(on({ kind: 'dates', dates: ['2027-03-11', '2027-03-19'] }), FIRST)).toBe('Repeats on 2 more dates: Thu 11 Mar, Fri 19 Mar.')
  })
  it('shortens a long list of dates', () => {
    const dates = Array.from({ length: 12 }, (_, index) => `2027-0${4 + Math.floor(index / 6)}-${String(1 + (index % 6) * 3).padStart(2, '0')}`)
    const text = describeDraftRepeat(on({ kind: 'dates', dates }), FIRST)
    expect(text).toMatch(/^Repeats on 12 more dates: .* and 4 more\.$/)
    expect(text.match(/,/g)).toHaveLength(7)
  })
  it('describes one that has been made, as the client page lists it', () => {
    const base = { weekday: 4, start_minutes: 600, treatment_duration_minutes: 90 }
    expect(describeRepeat(base)).toBe('Every Thursday at 10:00 · 90 min')
    expect(describeRepeat({ ...base, pattern: 'weeks', every_weeks: 1 })).toBe('Every Thursday at 10:00 · 90 min')
    expect(describeRepeat({ ...base, pattern: 'weeks', every_weeks: 3 })).toBe('Every 3 weeks, on Thursday at 10:00 · 90 min')
    expect(describeRepeat({ ...base, pattern: 'monthly', every_weeks: 1, month_week: 2 })).toBe('Every month, on the second Thursday at 10:00 · 90 min')
    expect(describeRepeat({ ...base, pattern: 'monthly', every_weeks: 1, month_week: 5 })).toBe('Every month, on the last Thursday at 10:00 · 90 min')
    expect(describeRepeat({ ...base, pattern: 'dates', every_weeks: 1 })).toBe('On chosen dates at 10:00 · 90 min')
  })
})

describe('the calendar for choosing dates', () => {
  it('lays a month out from a Monday', () => {
    const march = monthGrid('2027-03')
    expect(march.lead).toBe(0)
    expect(march.days).toHaveLength(31)
    expect(march.days[0]).toBe('2027-03-01')
    expect(march.days[30]).toBe('2027-03-31')
    expect(monthGrid('2027-02')).toMatchObject({ lead: 0 })
    expect(monthGrid('2027-02').days).toHaveLength(28)
    expect(monthGrid('2028-02').days).toHaveLength(29)
    // 1 January 2027 is a Friday: four blanks before it.
    expect(monthGrid('2027-01').lead).toBe(4)
    // 1 August 2027 is a Sunday: six blanks.
    expect(monthGrid('2027-08').lead).toBe(6)
  })
  it('moves between months, across a year end too', () => {
    expect(addMonths('2027-03', 1)).toBe('2027-04')
    expect(addMonths('2027-12', 1)).toBe('2028-01')
    expect(addMonths('2027-01', -1)).toBe('2026-12')
    expect(addMonths('2027-03', 0)).toBe('2027-03')
    expect(monthTitle('2027-03')).toBe('March 2027')
  })
})
