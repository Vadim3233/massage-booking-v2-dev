import { describe, expect, it } from 'vitest'
import { biggestDrop, busiestWanted, changeText, followUps, lastBookedText, outcomeOf, periodRange, preferences, shade, stageOf, stepLines, summarize, visitorName, visitsIn, wantedGrid, whatText } from './visitorsPresentation.js'

const at = (clock, day = '2026-11-06') => `${day}T${clock}:00Z`
const visit = (id, events, extra = {}) => ({ visit_id: id, started_at: events[0]?.at || at('10:00'), client_id: null, client_name: null, ...extra, events })
const e = (kind, detail = {}, clock = '10:00', day) => ({ kind, detail, at: at(clock, day) })

const booked = visit('a', [e('opened'), e('treatment'), e('length', { minutes: 60, people: 1 }), e('day', { date: '2026-11-10', free: 4, minutes: 60 }), e('time', { date: '2026-11-10', start: 660 }), e('payment'), e('booked', { booking_id: 'b', status: 'confirmed' })], { client_id: 'tom', client_name: 'Tom R' })
const full = visit('b', [e('opened', {}, '16:05'), e('length', { minutes: 60 }, '16:06'), e('day', { date: '2026-11-07', free: 0, minutes: 60 }, '16:06'), e('day', { date: '2026-11-08', free: 0, minutes: 60 }, '16:07')])
const wanted = visit('c', [e('opened', {}, '19:40', '2026-11-05'), e('day', { date: '2026-11-07', free: 0, minutes: 60 }, '19:41', '2026-11-05'), e('wanted', { date: '2026-11-07', start: 540, minutes: 60 }, '19:42', '2026-11-05'), e('wanted', { date: '2026-11-07', start: 540, minutes: 60 }, '19:43', '2026-11-05')], { client_id: 'sarah', client_name: 'Sarah K', last_booked: '2026-10-01' })
const asked = visit('d', [e('opened', {}, '09:00', '2026-11-04'), e('wanted', { date: '2026-11-14', start: 600 }, '09:01', '2026-11-04'), e('asked', { date: '2026-11-14', start: 600, minutes: 60 }, '09:01', '2026-11-04')])
const payment = visit('e', [e('opened', {}, '21:15', '2026-11-04'), e('time', { date: '2026-11-06', start: 1080 }, '21:16', '2026-11-04'), e('payment', {}, '21:18', '2026-11-04')], { client_id: 'james', client_name: 'James M' })
const looked = visit('f', [e('opened', {}, '11:48')])
const all = [booked, full, wanted, asked, payment, looked]

describe('a visit', () => {
  it('ends in one of five ways', () => {
    expect(all.map(outcomeOf)).toEqual(['booked', 'no_time', 'no_time', 'asked', 'payment', 'looked'])
  })
  it('got as far as its furthest step', () => {
    expect(all.map(stageOf)).toEqual([5, 2, 2, 2, 4, 0])
  })
  it('is named only when signed in', () => {
    expect(visitorName(booked)).toBe('Tom R')
    expect(visitorName(full)).toBe('Visitor')
  })
  it('says in a line what it was after', () => {
    expect(whatText(full)).toBe('60 min · looked at 2 days, none had a free time')
    expect(whatText(wanted)).toBe('60 min · wanted Sat 7 at 09:00')
    expect(whatText(asked)).toBe('60 min · asked about Sat 14 at 10:00')
    expect(whatText(looked)).toBe('opened the app and left')
  })
  it('lists its steps in words', () => {
    expect(stepLines(full).map(line => line.text)).toEqual(['Opened the booking page', 'Chose 60 min', 'Sat 7: no free times', 'Sun 8: no free times'])
    expect(stepLines(booked).at(-1).text).toBe('Booked')
  })
})

describe('the summary', () => {
  it('counts visits, bookings and people who found no time', () => {
    const sum = summarize(all)
    expect([sum.opened, sum.booked, sum.noTime]).toEqual([6, 1, 3])
    expect(sum.funnel.map(step => step.count)).toEqual([6, 2, 5, 2, 2, 1].map((_, index) => all.filter(item => stageOf(item) >= index).length))
  })
  it('names the biggest drop', () => {
    expect(biggestDrop([{ label: 'Opened the app', count: 10 }, { label: 'Chose a treatment', count: 8 }, { label: 'Looked at times', count: 2 }, { label: 'Booked', count: 1 }]))
      .toBe('6 of 8 stopped after “chose a treatment” and did not get to “looked at times”.')
    expect(biggestDrop([{ label: 'Opened the app', count: 0 }, { label: 'Booked', count: 0 }])).toBe('')
  })
  it('compares with before', () => {
    expect(changeText(9, 7)).toBe('+2')
    expect(changeText(3, 5)).toBe('−2')
    expect(changeText(4, 4)).toBe('same as before')
  })
  it('picks visits by the London day they started', () => {
    expect(visitsIn(all, '2026-11-06', '2026-11-06').map(item => item.visit_id)).toEqual(['a', 'b', 'f'])
    expect(periodRange('week', '2026-11-06')).toEqual({ days: 7, from: '2026-10-31', to: '2026-11-06', previousFrom: '2026-10-24', previousTo: '2026-10-30' })
  })
})

describe('the wanted times', () => {
  it('count each wanted time once per visit, by weekday and band', () => {
    const grid = wantedGrid(all)
    expect(grid[0][5]).toBe(1) // Saturday 09:00, tapped twice in one visit
    expect(grid[1][5]).toBe(1) // Saturday 10:00, asked about
    expect(grid.flat().reduce((sum, count) => sum + count, 0)).toBe(2)
    expect(busiestWanted(grid).text).toBe('Saturday Before 10 was wanted once when it wasn\'t free.')
    expect(busiestWanted(wantedGrid([full]))).toBe(null)
  })
  it('shade from pale to deep', () => {
    expect([0, 1, 2, 3, 4].map(count => shade(count, 4))).toEqual([0, 1, 2, 3, 4])
    expect(shade(3, 0)).toBe(0)
  })
  it('count the "None of these suit me" answers', () => {
    const prefs = preferences([visit('g', [e('opened'), e('wanted', { date: '2026-11-09', pref: 'after_work' })]), visit('h', [e('opened'), e('wanted', { date: '2026-11-10', pref: 'after_work' }), e('wanted', { date: '2026-11-10', pref: 'weekend' })])])
    expect(prefs).toEqual([{ key: 'after_work', label: 'After work', count: 2 }, { key: 'weekend', label: 'Weekend instead', count: 1 }])
  })
})

describe('who is worth a message', () => {
  it('is a known client who looked at times and did not book, latest visit first', () => {
    expect(followUps(all).map(item => item.client_name)).toEqual(['Sarah K', 'James M'])
  })
  it('leaves out someone who booked in a later visit', () => {
    const later = visit('z', [e('opened', {}, '12:00', '2026-11-06'), e('booked', { booking_id: 'x' }, '12:05', '2026-11-06')], { client_id: 'sarah', client_name: 'Sarah K' })
    expect(followUps([...all, later]).map(item => item.client_name)).toEqual(['James M'])
  })
  it('says when they last booked', () => {
    expect(lastBookedText('2026-10-01', '2026-11-06')).toBe('last booked 5 weeks ago')
    expect(lastBookedText('2026-11-05', '2026-11-06')).toBe('last booked 1 day ago')
    expect(lastBookedText(null, '2026-11-06')).toBe('no past bookings')
  })
})
