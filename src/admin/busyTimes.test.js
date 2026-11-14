import { describe, expect, it } from 'vitest'
import { bankHolidays, busySummary, clientTimes, headline, nextWeekday, quietDayTip, ranked, verdictWords, wantedTip, weekday } from './busyTimes.js'

const v = (date, start = '10:00', gbp = 90) => {
  const [h, m] = start.split(':').map(Number)
  return { date, start_minutes: h * 60 + m, net_gbp: gbp }
}

describe('bank holidays in England and Wales', () => {
  it('knows 2026, with Boxing Day moved off the Saturday', () => {
    expect(bankHolidays(2026).map(item => item.date)).toEqual(['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28'])
    expect(bankHolidays(2026).at(-1).name).toBe('Boxing Day (substitute day)')
  })
  it('moves Christmas on a weekend: 2027 and 2022', () => {
    expect(bankHolidays(2027).slice(-2).map(item => item.date)).toEqual(['2027-12-27', '2027-12-28'])
    expect(bankHolidays(2022).slice(-2).map(item => item.date)).toEqual(['2022-12-26', '2022-12-27'])
  })
  it('moves New Year’s Day off a weekend and finds Easter', () => {
    expect(bankHolidays(2028)[0].date).toBe('2028-01-03')
    expect(bankHolidays(2027).slice(1, 3).map(item => item.date)).toEqual(['2027-03-26', '2027-03-29'])
  })
})

describe('dates', () => {
  it('counts weekdays from Monday and finds the next one', () => {
    expect(weekday('2026-11-16')).toBe(0)
    expect(weekday('2026-11-15')).toBe(6)
    expect(nextWeekday('2026-11-14', 1)).toBe('2026-11-17')
    expect(nextWeekday('2026-11-17', 1)).toBe('2026-11-24')
  })
})

describe('busiest times on Income', () => {
  // Saturdays busy, Tuesdays quiet, Sundays never; the Summer bank holiday (Mon 31 Aug) had three.
  const visits = []
  for (let week = 0; week < 10; week += 1) {
    const monday = new Date(Date.UTC(2026, 7, 3 + week * 7))
    const day = offset => new Date(monday.getTime() + offset * 86400000).toISOString().slice(0, 10)
    visits.push(v(day(5), '11:00', 100), v(day(5), '14:00', 100))
    if (week % 3 === 0) visits.push(v(day(1), '18:00', 80))
    if (week % 2 === 0 && day(0) !== '2026-08-31') visits.push(v(day(0), '10:00', 90))
  }
  visits.push(v('2026-08-31', '10:00'), v('2026-08-31', '12:00'), v('2026-08-31', '15:00'))
  const summary = busySummary({ today: '2026-11-14', visits })

  it('ranks the days, leaving days off out of the quietest', () => {
    const { busy, empty } = ranked(summary.days)
    expect(busy[0]).toMatchObject({ index: 5, best: true })
    expect(busy.at(-1)).toMatchObject({ index: 1, quietest: true })
    expect(empty.map(row => row.index)).toEqual([2, 3, 4, 6])
    expect(headline('days', summary, 'bookings')).toBe('Saturday is your best day, Tuesday your quietest.')
  })
  it('compares a bank holiday with a normal day', () => {
    expect(summary.holidays.past).toHaveLength(1)
    expect(summary.holidays.past[0]).toMatchObject({ date: '2026-08-31', bookings: 3, verdict: 'busier' })
    expect(verdictWords(summary.holidays.past[0])).toMatch(/times busier than a normal Monday/)
    expect(headline('hols', summary)).toBe('Bank holidays have been busier than a normal day.')
  })
  it('says the months are early days and names the next bank holiday', () => {
    expect(summary.fullYear).toBe(false)
    expect(headline('months', summary, 'bookings')).toMatch(/so far\.$/)
    expect(summary.upcoming).toMatchObject({ date: '2026-12-25', name: 'Christmas Day', inDays: 41 })
    expect(busySummary({ today: '2026-10-01', visits }).upcoming).toBeNull()
  })
  it('suggests the next quiet day for a special offer', () => {
    expect(quietDayTip(summary)).toEqual({ day: 'Tuesday', date: '2026-11-17' })
  })
  it('finds when people wanted a time that was full', () => {
    const wanted = [{ date: '2026-11-07', start_minutes: 1080 }, { date: '2026-10-31', start_minutes: 1110 }, { date: '2026-11-05', start_minutes: 600 }]
    const withWanted = busySummary({ today: '2026-11-14', visits, wanted })
    expect(withWanted.wanted.days[5]).toBe(2)
    expect(wantedTip(withWanted)).toMatchObject({ day: 'Saturday', count: 2, date: '2026-11-21' })
    expect(wantedTip(withWanted).part.key).toBe('evening')
    expect(wantedTip(summary)).toBeNull()
  })
  it('ignores today and later, and is empty without visits', () => {
    expect(busySummary({ today: '2026-11-14', visits: [v('2026-11-14'), v('2026-11-20')] }).count).toBe(0)
  })
})

describe('when a client books', () => {
  const today = '2026-11-14'
  it('finds a usual day, part of the day and time', () => {
    const times = clientTimes([v('2026-08-03'), v('2026-08-24'), v('2026-09-14'), v('2026-10-05'), v('2026-10-21', '14:00')], today)
    expect(times.sentence).toBe('Usually Monday mornings, around 10:00.')
    expect(times.usualDay).toBe(0)
    expect(times.days).toEqual([4, 0, 1, 0, 0, 0, 0])
    expect(times.parts).toEqual([4, 1, 0])
  })
  it('names two days when no single day stands out', () => {
    const times = clientTimes([v('2026-09-07', '18:00'), v('2026-09-12', '18:30'), v('2026-09-21', '19:00'), v('2026-09-26', '18:00')], today)
    expect(times.sentence).toBe('Usually Mondays or Saturdays, in the evening, around 18:00.')
    expect(times.usualDay).toBeNull()
  })
  it('keeps it to one line before three visits', () => {
    expect(clientTimes([v('2026-11-06', '19:00')], today).sentence).toBe('The only visit so far was on a Friday evening.')
    expect(clientTimes([v('2026-10-30', '19:00'), v('2026-11-06', '18:00')], today).sentence).toBe('Both visits so far were on a Friday evening.')
    expect(clientTimes([], today).count).toBe(0)
  })
})
