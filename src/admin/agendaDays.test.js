import { describe, expect, it } from 'vitest'
import { agendaDays, blockHeading, blockSpan, mergeExtras, specialLine } from './agendaDays.js'

// Today is Wednesday 14 October 2026. Saturdays are not worked in the usual week used here.
const booking = (date, start = 840) => ({ id: `${date}-${start}`, date, start_minutes: start, booking_status: 'confirmed' })
const block = (date, changes = {}) => ({ id: `${changes.group_id || 'g1'}-${date}`, group_id: 'g1', kind: 'blocked', title: 'Christmas Holidays', date, start_minutes: 0, end_minutes: 1440, ...changes })
const wholeDays = (dates, changes = {}) => dates.map(date => block(date, changes))
const special = (date, changes = {}) => ({ date, available: true, start_minutes: 720, end_minutes: 1020, start_mode: 'fixed', fixed_start_minutes: 870, note: null, ...changes })
const week = [1, 2, 3, 4, 5, 6, 7].map(weekday => ({ weekday, available: weekday !== 6, start_minutes: 720, end_minutes: 1260, start_mode: 'flexible', fixed_start_minutes: null }))
const range = { start: '2026-10-14', end: '2026-11-14', day: '2026-10-14' }
// Browsers and Node differ on whether a short date has a comma after the weekday ("Tue, 22 Dec" or "Tue 22 Dec").
const plain = text => text.replace(/,/g, '')
const shape = entries => entries.map(entry => entry.type === 'quiet' ? `quiet:${entry.items.map(item => `${item.date.slice(5)} ${item.kind}`).join(', ')}` : `${entry.type}:${entry.date.slice(5)}`)

describe('the days the Agenda lists', () => {
  it('are the days with bookings, and always today, even when nothing is booked', () => {
    const entries = agendaDays({ ...range, bookings: [booking('2026-10-20'), booking('2026-10-20', 900), booking('2026-10-22')] })
    expect(shape(entries)).toEqual(['day:10-14', 'day:10-20', 'day:10-22'])
    expect(entries[0].bookings).toEqual([])
    expect(entries[1].bookings).toHaveLength(2)
  })

  it('go with a special day when there are bookings, and stand alone as a quiet line when there are none', () => {
    const entries = agendaDays({ ...range, bookings: [booking('2026-10-20')], overrides: [special('2026-10-20'), special('2026-10-25', { available: false, start_minutes: null, end_minutes: null, start_mode: 'flexible', fixed_start_minutes: null, note: 'Family day' })] })
    expect(shape(entries)).toEqual(['day:10-14', 'day:10-20', 'quiet:10-25 off'])
    expect(entries[1].special.fixed_start_minutes).toBe(870)
    expect(entries[2].items[0].text).toBe('Day off · Family day')
  })

  it('ignore a special day outside the days on show', () => {
    expect(shape(agendaDays({ ...range, bookings: [], overrides: [special('2026-11-20'), special('2026-09-01')] }))).toEqual(['day:10-14'])
  })

  it('show time away as one banner at its first day, and not the days inside it', () => {
    const entries = agendaDays({ ...range, bookings: [], blocks: wholeDays(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']) })
    expect(shape(entries)).toEqual(['day:10-14', 'away:10-26'])
    expect(blockHeading(entries[1].group)).toBe('Away · Christmas Holidays')
    expect(plain(blockSpan(entries[1].group))).toBe('Mon 26 Oct to Fri 30 Oct · 5 days')
  })

  it('show time away that began before the days on show where the list begins, counting all its days', () => {
    const rows = wholeDays(['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'])
    const entries = agendaDays({ ...range, bookings: [], blocks: rows })
    expect(shape(entries)).toEqual(['away:10-14', 'day:10-14'])
    expect(plain(blockSpan(entries[0].group))).toBe('Sat 10 Oct to Sun 18 Oct · 9 days')
    expect(entries[1].away).toBe(entries[0].group)
  })

  it('say when time away starts or ends part-way through a day, and call one day "all day"', () => {
    const part = [block('2026-12-22', { start_minutes: 900 }), block('2026-12-23'), block('2026-12-24', { end_minutes: 720 })]
    const entries = agendaDays({ start: '2026-12-01', end: '2027-01-01', day: '2026-10-14', bookings: [], blocks: part })
    expect(plain(blockSpan(entries[0].group))).toBe('Tue 22 Dec 15:00 to Thu 24 Dec 12:00 · 3 days')
    const single = agendaDays({ ...range, bookings: [], blocks: wholeDays(['2026-10-21'], { group_id: 'one' }) })
    expect(plain(blockSpan(single[1].group))).toBe('Wed 21 Oct · all day')
  })

  it('show a few hours blocked in the day, in time order among its bookings', () => {
    const entries = agendaDays({ ...range, bookings: [booking('2026-10-20', 600), booking('2026-10-20', 780)], blocks: [block('2026-10-20', { group_id: 'dentist', title: 'Dentist', start_minutes: 660, end_minutes: 720 })] })
    expect(entries[1].rows.map(row => row.kind)).toEqual(['booking', 'block', 'booking'])
  })

  it('show a few hours blocked on a free day as a quiet line with the hours', () => {
    const entries = agendaDays({ ...range, bookings: [], blocks: [block('2026-10-21', { group_id: 'dentist', title: 'Dentist', start_minutes: 660, end_minutes: 720 })] })
    expect(shape(entries)).toEqual(['day:10-14', 'quiet:10-21 block'])
    expect(entries[1].items[0].text).toBe('11:00–12:00 · Dentist')
    expect(entries[1].items[0].row.title).toBe('Dentist')
  })

  it('keep a booking made inside time away, and say so under its date', () => {
    const entries = agendaDays({ ...range, bookings: [booking('2026-10-21')], blocks: wholeDays(['2026-10-20', '2026-10-21', '2026-10-22']) })
    expect(shape(entries)).toEqual(['day:10-14', 'away:10-20', 'day:10-21'])
    expect(entries[2].away).toBe(entries[1].group)
  })

  it('keep today, with the banner above it, when today is inside time away', () => {
    const entries = agendaDays({ ...range, bookings: [], blocks: wholeDays(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']) })
    expect(shape(entries)).toEqual(['away:10-14', 'day:10-14'])
  })

  it('name a personal event by its title, and an untitled block "Blocked time"', () => {
    const event = agendaDays({ ...range, bookings: [], blocks: wholeDays(['2026-10-21', '2026-10-22'], { group_id: 'wedding', kind: 'personal_event', title: "Sam's wedding" }) })
    expect(blockHeading(event[1].group)).toBe("Sam's wedding")
    const untitled = agendaDays({ ...range, bookings: [], blocks: wholeDays(['2026-10-21', '2026-10-22'], { group_id: 'away', title: '' }) })
    expect(blockHeading(untitled[1].group)).toBe('Away')
    const timed = agendaDays({ ...range, bookings: [], blocks: [block('2026-10-23', { group_id: 'x', title: null, start_minutes: 600, end_minutes: 660 })] })
    expect(timed[1].items[0].text).toBe('10:00–11:00 · Blocked time')
  })
})

describe('Show every day', () => {
  it('lists every date once, with free days and the usual day off told apart and one run of quiet lines between bookings', () => {
    const entries = agendaDays({ start: '2026-10-14', end: '2026-10-21', day: '2026-10-14', bookings: [booking('2026-10-16')], weekly: week, showEvery: true })
    expect(shape(entries)).toEqual(['day:10-14', 'quiet:10-15 free', 'day:10-16', 'quiet:10-17 closed, 10-18 free, 10-19 free, 10-20 free'])
    expect(entries[3].items.map(item => item.text)).toEqual(['usual day off', 'free', 'free', 'free'])
  })

  it('says nothing about the usual day off while the usual week is not known', () => {
    const entries = agendaDays({ start: '2026-10-14', end: '2026-10-19', day: '2026-10-14', bookings: [], weekly: [], showEvery: true })
    expect(entries[1].items.map(item => item.kind)).toEqual(['free', 'free', 'free', 'free'])
  })

  it('gives each day inside time away its own quiet line, counted, after the banner', () => {
    const entries = agendaDays({ ...range, end: '2026-10-31', bookings: [], blocks: wholeDays(['2026-10-26', '2026-10-27', '2026-10-28']), weekly: week, showEvery: true })
    const from = entries.findIndex(entry => entry.type === 'away')
    expect(entries[from].date).toBe('2026-10-26')
    expect(entries[from + 1].items.map(item => `${item.date.slice(5)} ${item.kind} ${item.text}`).slice(0, 2)).toEqual([
      '10-27 away Away · Christmas Holidays · day 2 of 3',
      '10-28 away Away · Christmas Holidays · day 3 of 3',
    ])
    expect(entries[from + 1].items[2].kind).toBe('free')
  })

  it('shows a special day and a few hours blocked instead of "free" on their dates', () => {
    const entries = agendaDays({ start: '2026-10-14', end: '2026-10-19', day: '2026-10-14', bookings: [], overrides: [special('2026-10-16')], blocks: [block('2026-10-17', { group_id: 'dentist', title: 'Dentist', start_minutes: 660, end_minutes: 720 })], weekly: week, showEvery: true })
    expect(entries[1].items.map(item => `${item.date.slice(5)} ${item.kind}`)).toEqual(['10-15 free', '10-16 special', '10-17 block', '10-18 free'])
  })

  it('keeps days with bookings as full days, and still starts the list with today', () => {
    const entries = agendaDays({ start: '2026-10-10', end: '2026-10-16', day: '2026-10-14', bookings: [booking('2026-10-12')], weekly: week, showEvery: true })
    expect(shape(entries).filter(text => text.startsWith('day:'))).toEqual(['day:10-12', 'day:10-14'])
  })
})

describe('the words for blocks and special days', () => {
  it('describe special hours with the first appointment, a day off, and a note', () => {
    expect(specialLine(special('2026-10-28'))).toBe('Special hours 12:00–17:00, first appointment at 14:30')
    expect(specialLine(special('2026-10-28', { start_mode: 'flexible', fixed_start_minutes: null }))).toBe('Special hours 12:00–17:00')
    expect(specialLine(special('2026-10-28', { available: false, note: 'Family day' }))).toBe('Day off · Family day')
  })
})

describe('blocks and special days read a month at a time', () => {
  it('are put together without repeating a block that ran over two months, or a special day', () => {
    const rows = wholeDays(['2026-10-30', '2026-10-31', '2026-11-01'])
    const merged = mergeExtras([
      { blocks: rows, overrides: [special('2026-10-28')] },
      { blocks: rows, overrides: [special('2026-10-28', { note: 'newer' }), special('2026-11-03')] },
    ])
    expect(merged.blocks).toHaveLength(3)
    expect(merged.overrides.map(entry => `${entry.date} ${entry.note}`)).toEqual(['2026-10-28 newer', '2026-11-03 null'])
  })
})
