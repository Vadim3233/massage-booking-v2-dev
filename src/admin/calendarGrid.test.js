import { describe, expect, it } from 'vitest'
import { bookingTone, calendarDays, clampRow, hiddenWeekdays, hoursWords, isoWeek, mergeRanges, monthGrid, monthSummary, placeColumns, rangePieces, shiftMonth, shortName, weekDates, weekSpan, ROW_MAX, ROW_MIN } from './calendarGrid.js'

const booking = (id, date, start, extra = {}) => ({
  id, date, start_minutes: start, treatment_duration_minutes: 60, travel_buffer_minutes: 30, booking_status: 'confirmed',
  clients: { first_name: 'Sarah', last_name: 'Kent' }, booking_sessions: [{ duration_minutes: 60, position: 1 }],
  booking_payments: { status: 'paid', method: 'bank_transfer' }, ...extra,
})
const hours = (date, start, end, extra = {}) => ({ date, source: 'usual', available: start != null, start_minutes: start, end_minutes: end, ...extra })

describe('month grid', () => {
  it('starts on the Monday on or before the 1st and always has six weeks', () => {
    const grid = monthGrid('2026-11-23')
    expect(grid.start).toBe('2026-10-26')
    expect(grid.end).toBe('2026-12-07')
    expect(grid.weeks).toHaveLength(6)
    expect(grid.weeks[0].days[6]).toBe('2026-11-01')
    expect(grid.weeks.map(week => week.number)).toEqual([44, 45, 46, 47, 48, 49])
  })
  it('a month starting on a Monday starts on the 1st', () => expect(monthGrid('2027-02-10').start).toBe('2027-02-01'))
  it('UK week numbers round the new year', () => {
    expect(isoWeek('2026-12-31')).toBe(53)
    expect(isoWeek('2027-01-01')).toBe(53)
    expect(isoWeek('2027-01-04')).toBe(1)
  })
  it('moves by whole months, whatever the day', () => {
    expect(shiftMonth('2026-01-31', 1)).toBe('2026-02-01')
    expect(shiftMonth('2026-01-15', -1)).toBe('2025-12-01')
  })
  it('a week is Monday to Sunday on a computer and three days on a phone', () => {
    expect(weekDates('2026-11-25', false)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29'])
    expect(weekDates('2026-11-25', true)).toEqual(['2026-11-25', '2026-11-26', '2026-11-27'])
  })
  it('reads a range of more than 31 days in pieces', () => {
    expect(rangePieces('2026-10-26', '2026-12-07')).toEqual([['2026-10-26', '2026-11-26'], ['2026-11-26', '2026-12-07']])
  })
  it('puts pieces back together without doubles', () => {
    const merged = mergeRanges([{ bookings: [{ id: 'a' }], blocks: [{ id: 'x' }], dayHours: [{ date: '2026-11-01' }], holds: [], offers: [] }, { bookings: [{ id: 'a' }, { id: 'b' }], blocks: [{ id: 'x' }], dayHours: [{ date: '2026-11-02' }], holds: [], offers: [] }])
    expect(merged.bookings.map(row => row.id)).toEqual(['a', 'b'])
    expect(merged.blocks).toHaveLength(1)
    expect(merged.dayHours).toHaveLength(2)
  })
})

describe('names and colours', () => {
  it('short names', () => {
    expect(shortName(booking('a', '2026-11-23', 900))).toBe('Sarah K.')
    expect(shortName(booking('a', '2026-11-23', 900), { first: true })).toBe('Sarah')
    expect(shortName(booking('a', '2026-11-23', 900, { booking_sessions: [{}, {}] }))).toBe('Sarah K. +1')
    expect(shortName({ clients: null })).toBe('No name')
  })
  it('paid is ok; money still to come is wait before the visit and owed after it', () => {
    expect(bookingTone(booking('a', '2026-11-20', 900), '2026-11-23', 600)).toBe('ok')
    const awaited = booking('b', '2026-11-25', 900, { booking_payments: { status: 'awaiting_transfer', method: 'bank_transfer' } })
    expect(bookingTone(awaited, '2026-11-23', 600)).toBe('wait')
    expect(bookingTone({ ...awaited, date: '2026-11-20' }, '2026-11-23', 600)).toBe('owed')
    expect(bookingTone({ ...awaited, date: '2026-11-23' }, '2026-11-23', 959)).toBe('wait')
    expect(bookingTone({ ...awaited, date: '2026-11-23' }, '2026-11-23', 960)).toBe('owed')
  })
  it('a transfer to check, cash to approve or a client still to confirm needs the Admin', () => {
    expect(bookingTone(booking('c', '2026-11-25', 900, { booking_status: 'awaiting_payment_verification', booking_payments: { status: 'awaiting_verification' } }), '2026-11-23', 0)).toBe('needs')
    expect(bookingTone(booking('d', '2026-11-25', 900, { booking_status: 'awaiting_cash_approval', booking_payments: { status: 'awaiting_approval', method: 'cash' } }), '2026-11-23', 0)).toBe('needs')
  })
  it('paid but made longer still owes the extra', () => {
    expect(bookingTone(booking('e', '2026-11-20', 900, { balance_due_gbp: 30 }), '2026-11-23', 0)).toBe('owed')
  })
  it('cancelled and no-show', () => {
    expect(bookingTone(booking('f', '2026-11-20', 900, { booking_status: 'cancelled' }), '2026-11-23', 0)).toBe('cancel')
    expect(bookingTone(booking('g', '2026-11-20', 900, { booking_status: 'no_show' }), '2026-11-23', 0)).toBe('noshow')
  })
})

describe('days', () => {
  const dates = ['2026-11-23', '2026-11-24', '2026-11-28']
  const data = {
    bookings: [booking('a', '2026-11-23', 900), booking('z', '2026-11-23', 960, { booking_status: 'cancelled' }), booking('s', '2026-11-28', 600)],
    blocks: [{ id: 'k', date: '2026-11-24', kind: 'blocked', title: 'Dentist', start_minutes: 1020, end_minutes: 1080 }],
    dayHours: [hours('2026-11-23', 870, 1110), hours('2026-11-24', 720, 960, { source: 'special' }), hours('2026-11-28', null, null)],
    holds: [], offers: [{ id: 'o', date: '2026-11-24', start_minutes: 780, duration_minutes: 60, price_gbp: 60 }],
  }
  it('lists bookings, blocks and offers in time order and leaves cancelled ones out unless asked', () => {
    const days = calendarDays(data, dates, {}, '2026-11-23', 0, 0)
    expect(days.get('2026-11-23').entries.map(entry => entry.id)).toEqual(['a'])
    expect(days.get('2026-11-24').entries.map(entry => entry.id)).toEqual(['o', 'k'])
    expect(calendarDays(data, dates, { showCancelled: true }, '2026-11-23', 0, 0).get('2026-11-23').entries.map(entry => entry.id)).toEqual(['a', 'z'])
    expect(calendarDays(data, dates, { blocked: false }, '2026-11-23', 0, 0).get('2026-11-24').entries.map(entry => entry.id)).toEqual(['o'])
  })
  it('a booking on a day off is never hidden', () => {
    const day = calendarDays(data, dates, {}, '2026-11-23', 0, 0).get('2026-11-28')
    expect(day.open).toBe(false)
    expect(day.entries).toHaveLength(1)
  })
  it('how full: travel either side counts, cancelled does not', () => {
    const day = calendarDays(data, dates, {}, '2026-11-23', 0, 0).get('2026-11-23')
    // 14:30–18:30 is 240 min; the 15:00 booking takes 14:30–16:30 with its travel.
    expect(day.full).toBeCloseTo(120 / 240)
    expect(day.booked).toBe(1)
  })
  it('hours in words', () => {
    const days = calendarDays(data, dates, {}, '2026-11-23', 0, 0)
    expect(hoursWords(days.get('2026-11-23'))).toBe('14:30–18:30')
    expect(hoursWords(days.get('2026-11-24'))).toBe('Special 12:00–16:00')
    expect(hoursWords(days.get('2026-11-28'))).toBe('Day off')
  })
  it('time away over several days marks each day and is not a line of its own', () => {
    const away = { ...data, blocks: ['2026-11-23', '2026-11-24'].map((date, index) => ({ id: `w${index}`, group_id: 'trip', date, kind: 'blocked', title: 'Spain', start_minutes: 0, end_minutes: 1440 })) }
    const days = calendarDays(away, dates, {}, '2026-11-23', 0, 0)
    expect(days.get('2026-11-24').away).toMatchObject({ title: 'Away · Spain', number: 2, total: 2 })
    expect(days.get('2026-11-24').open).toBe(false)
    expect(days.get('2026-11-24').entries.filter(entry => entry.kind === 'block')).toHaveLength(0)
  })
  it('hides a weekday only when all its days are empty days off', () => {
    const days = calendarDays(data, dates, {}, '2026-11-23', 0, 0)
    expect(hiddenWeekdays(days, dates, false).has(6)).toBe(false)
    const empty = calendarDays({ ...data, bookings: [] }, dates, {}, '2026-11-23', 0, 0)
    expect(hiddenWeekdays(empty, dates, false).has(6)).toBe(true)
    expect(hiddenWeekdays(empty, dates, true).size).toBe(0)
  })
  it('month line counts sessions and free working days from today', () => {
    const days = calendarDays(data, dates, {}, '2026-11-23', 0, 0)
    expect(monthSummary(days, '2026-11', '2026-11-23')).toBe('2 sessions · 1 working day still free')
    expect(monthSummary(days, '2026-11', '2026-12-05')).toBe('2 sessions')
  })
})

describe('week grid', () => {
  it('covers working hours and entries in whole hours', () => {
    const span = weekSpan([{ date: 'a', hours: { available: true, start_minutes: 870, end_minutes: 1110 }, entries: [{ start: 450, end: 510 }] }])
    expect(span).toEqual({ from: 420, to: 1140 })
  })
  it('overlapping entries share the width', () => {
    const placed = placeColumns([{ id: 1, start: 600, end: 660 }, { id: 2, start: 630, end: 690 }, { id: 3, start: 700, end: 760 }])
    expect(placed.map(row => [row.lane, row.lanes])).toEqual([[0, 2], [1, 2], [0, 1]])
  })
  it('row height stays within bounds', () => {
    expect(clampRow(10)).toBe(ROW_MIN)
    expect(clampRow(999)).toBe(ROW_MAX)
    expect(clampRow('x')).toBe(108)
  })
})

describe('audit fixes', () => {
  const dates = ['2026-11-23', '2026-11-24']
  it('a day not read yet is unknown, not a day off, and never hides its weekday', () => {
    const days = calendarDays({ bookings: [], blocks: [], dayHours: [], holds: [], offers: [] }, dates, {}, '2026-11-23', 0, 0)
    expect(days.get('2026-11-23').unknown).toBe(true)
    expect(hoursWords(days.get('2026-11-23'))).toBe('')
    expect(hiddenWeekdays(days, dates, false).size).toBe(0)
  })
  it('time away counts over the whole block, even from before the days read', () => {
    const row = (id, date, start = 0, end = 1440) => ({ id, group_id: 'trip', date, kind: 'blocked', title: 'Spain', start_minutes: start, end_minutes: end })
    const data = { bookings: [], holds: [], offers: [], dayHours: dates.map(date => hours(date, 600, 1080)), blocks: [row('b', '2026-11-23'), row('c', '2026-11-24', 0, 600)], groupBlocks: [row('a', '2026-11-22'), row('b', '2026-11-23'), row('c', '2026-11-24', 0, 600)] }
    const days = calendarDays(data, dates, {}, '2026-11-23', 0, 0)
    expect(days.get('2026-11-23').away).toMatchObject({ number: 2, total: 2 })
    // The morning off at the end is timed blocked time; the afternoon is still worked.
    expect(days.get('2026-11-24').away).toBeNull()
    expect(days.get('2026-11-24').entries.map(entry => entry.id)).toEqual(['c'])
  })
  it('a no-show shows only with the cancelled ones', () => {
    const data = { blocks: [], holds: [], offers: [], dayHours: [hours('2026-11-23', 600, 1080)], bookings: [booking('n', '2026-11-23', 700, { booking_status: 'no_show' })] }
    expect(calendarDays(data, dates, {}, '2026-11-23', 0, 0).get('2026-11-23').entries).toHaveLength(0)
    expect(calendarDays(data, dates, { showCancelled: true }, '2026-11-23', 0, 0).get('2026-11-23').entries).toHaveLength(1)
  })
})
