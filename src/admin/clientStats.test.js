import { describe, expect, it } from 'vitest'
import { agoWords, clientLine, gapWords, goneQuiet, matches, mostLoyal, newNotBack, overdueWeeks, pounds, tagCounts, tiles } from './clientStats.js'

const row = (id, extra) => ({ id, first_name: id, last_name: 'Test', phone: null, email: null, visits: 0, first_visit: null, last_visit: null, gap_days: null, next_date: null, paid_gbp: 0, tag: null, overdue_days: null, ...extra })

describe('client stats words', () => {
  it('says a gap the way people do', () => {
    expect(gapWords(1)).toBe('every 1 day')
    expect(gapWords(10)).toBe('every 10 days')
    expect(gapWords(21)).toBe('every ~3 weeks')
    expect(gapWords(25)).toBe('every ~4 weeks')
    expect(gapWords(90)).toBe('every ~3 months')
    expect(gapWords(null)).toBe('')
  })
  it('says how long ago', () => {
    expect(agoWords(0)).toBe('today')
    expect(agoWords(1)).toBe('yesterday')
    expect(agoWords(9)).toBe('9 days ago')
    expect(agoWords(28)).toBe('4 weeks ago')
    expect(agoWords(120)).toBe('4 months ago')
  })
  it('never says zero weeks overdue', () => {
    expect(overdueWeeks(2)).toBe(1)
    expect(overdueWeeks(56)).toBe(8)
  })
  it('rounds money to whole pounds', () => {
    expect(pounds('1260.00')).toBe('£1,260')
    expect(pounds(null)).toBe('£0')
  })
})

describe('the tiles', () => {
  it('shows totals, new this month, came back and usual gap', () => {
    const shown = tiles({ today: '2026-11-12', total: 64, active: 31, new_this_month: 4, new_last_month: 6, visited: 36, came_back: 21, usual_gap_days: 24 })
    expect(shown.map(tile => [tile.label, tile.value, tile.sub])).toEqual([
      ['Clients', '64', '31 active in the last 90 days'],
      ['New in November', '4', 'October had 6'],
      ['Came back', '58%', '21 of 36 booked again'],
      ['Usual gap', '~3 weeks', 'between visits for regulars'],
    ])
  })
  it('copes with no visits yet and January', () => {
    const shown = tiles({ today: '2027-01-03', total: 2, active: 0, new_this_month: 0, new_last_month: 0, visited: 0, came_back: 0, usual_gap_days: null })
    expect(shown[1].sub).toBe('December had 0')
    expect(shown[2].value).toBe('–')
    expect(shown[3].value).toBe('–')
  })
})

describe('a client in the list', () => {
  const today = '2026-11-12'
  it('reads visits, rhythm, last and next', () => {
    expect(clientLine(row('a', { visits: 14, gap_days: 21, last_visit: '2026-11-02', next_date: '2026-11-23' }), today)).toBe('14 visits · every ~3 weeks · last 2 Nov · next 23 Nov')
    expect(clientLine(row('b', { visits: 1, last_visit: '2026-09-27' }), today)).toBe('1 visit · 27 Sept')
    expect(clientLine(row('c', { visits: 2, gap_days: 30, last_visit: '2026-10-01' }), today)).toBe('2 visits · last 1 Oct')
    expect(clientLine(row('d'), today)).toBe('No visits yet')
    expect(clientLine(row('e', { next_date: '2026-11-20' }), today)).toBe('No visits yet · booked 20 Nov')
  })
})

describe('the lists', () => {
  const today = '2026-11-12'
  const clients = [
    row('quietA', { tag: 'quiet', visits: 9, overdue_days: 20, gap_days: 28, last_visit: '2026-09-13' }),
    row('quietB', { tag: 'quiet', visits: 14, overdue_days: 60, gap_days: 21, last_visit: '2026-08-24', paid_gbp: '1260' }),
    row('fresh', { tag: 'new', visits: 1, first_visit: '2026-10-12', last_visit: '2026-10-12' }),
    row('freshBooked', { tag: 'new', visits: 1, first_visit: '2026-10-20', last_visit: '2026-10-20', next_date: '2026-11-20' }),
    row('old', { visits: 1, first_visit: '2026-06-01', last_visit: '2026-06-01' }),
    row('loyal', { tag: 'regular', visits: 24, paid_gbp: '2040' }),
    row('couple', { tag: 'regular', visits: 15, paid_gbp: '2550' }),
  ]
  it('puts the most overdue first in Gone quiet', () => {
    expect(goneQuiet(clients).map(c => c.id)).toEqual(['quietB', 'quietA'])
  })
  it('lists recent first-timers with nothing booked', () => {
    expect(newNotBack(clients, today).map(c => c.id)).toEqual(['fresh'])
  })
  it('ranks the most loyal by visits or by money', () => {
    expect(mostLoyal(clients, 'visits', 3).map(c => c.id)).toEqual(['loyal', 'couple', 'quietB'])
    expect(mostLoyal(clients, 'spent', 2).map(c => c.id)).toEqual(['couple', 'loyal'])
  })
  it('counts each tag', () => {
    expect(tagCounts(clients)).toEqual({ regular: 2, new: 2, quiet: 2, lapsed: 0 })
  })
  it('searches inside a filter by name, email or phone digits', () => {
    const sarah = row('s', { first_name: 'Sarah', last_name: 'Mitchell', email: 'sarah@example.test', phone: '07700 900 123' })
    expect(matches(sarah, 'sarah mit')).toBe(true)
    expect(matches(sarah, 'example')).toBe(true)
    expect(matches(sarah, '900123')).toBe(true)
    expect(matches(sarah, 'james')).toBe(false)
    expect(matches(sarah, '  ')).toBe(true)
  })
})
