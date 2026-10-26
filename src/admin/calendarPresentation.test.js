import { describe, expect, it } from 'vitest'
import { bookingEnd, bookingState, canNavigateTo, dayContext, hasStarted, daySummary, getBookingCardVariant, getBookingStatusLabel, extrasList, nextUp, shiftDate, treatmentName } from './calendarPresentation.js'

it('a booking ends when its treatment ends, never counting the travel time either side', () => {
  expect(bookingEnd({ start_minutes: 870, treatment_duration_minutes: 60, travel_buffer_minutes: 60 })).toBe(930)
  // Two sessions of one booking: the end is the whole treatment (90 + 60), whatever each session's own length.
  expect(bookingEnd({ start_minutes: 600, treatment_duration_minutes: 150, travel_buffer_minutes: 45 })).toBe(750)
})
it('names the treatment on a card without repeating its length', () => {
  expect(treatmentName({ booking_sessions: [{ service_name_snapshot: 'Deep Tissue', duration_minutes: 60 }] })).toBe('Deep Tissue')
  expect(treatmentName({ booking_sessions: [{ service_name_snapshot: 'A' }, { service_name_snapshot: 'B' }] })).toBe('2 sessions')
  expect(treatmentName({ booking_sessions: [] })).toBe('Appointment')
  expect(treatmentName({})).toBe('Appointment')
})
it('handles London calendar dates across DST and month boundaries', () => {
  expect(shiftDate('2026-03-29', 1)).toBe('2026-03-30')
  expect(shiftDate('2026-10-31', 1)).toBe('2026-11-01')
})
it('a booking waiting for a transfer keeps occupying displayed gaps, however old', () => {
  const now = Date.now()
  const b = { booking_status: 'awaiting_transfer', start_minutes: 780, treatment_duration_minutes: 60, travel_buffer_minutes: 60 }
  const data = { dayHours: [{ date: '2026-10-05', source: 'special', available: true, start_minutes: 600, end_minutes: 1200 }], holds: [], blocks: [], bookings: [b] }
  expect(dayContext(data, '2026-10-05', now).gaps).toEqual([[600, 720], [900, 1200]])
})
it('merges overlapping buffers and blocks and ignores expired holds', () => {
  const now = Date.now()
  const data = { dayHours: [{ date: '2026-10-05', source: 'usual', available: true, start_minutes: 600, end_minutes: 1200 }], holds: [{ expires_at: new Date(now - 1).toISOString() }], blocks: [{ start_minutes: 700, end_minutes: 850 }], bookings: [{ booking_status: 'confirmed', start_minutes: 800, treatment_duration_minutes: 60, travel_buffer_minutes: 60 }] }
  expect(dayContext(data, '2026-10-05', now).gaps).toEqual([[600, 700], [920, 1200]])
  expect(dayContext(data, '2026-10-05', now).holds).toEqual([])
})

it('names the appointment happening now, or else the next one going ahead, in London time', () => {
  const make = (id, date, start, status = 'confirmed') => ({ id, date, start_minutes: start, treatment_duration_minutes: 60, booking_status: status })
  const list = [make('done', '2026-10-12', 540), make('cancelled', '2026-10-12', 840, 'cancelled'), make('later', '2026-10-12', 960), make('tomorrow', '2026-10-13', 600)]
  // 14:10 in London (BST, so 13:10 UTC): the cancelled 14:00 is not "now", the 16:00 is next.
  expect(nextUp(list, new Date('2026-10-12T13:10:00Z'))).toEqual({ id: 'later', now: false })
  // 16:30: the 16:00 appointment is under way.
  expect(nextUp(list, new Date('2026-10-12T15:30:00Z'))).toEqual({ id: 'later', now: true })
  // After the last one today, the next is tomorrow's; with nothing ahead there is nothing to name.
  expect(nextUp(list, new Date('2026-10-12T18:30:00Z'))).toEqual({ id: 'tomorrow', now: false })
  expect(nextUp(list, new Date('2026-10-13T12:00:00Z'))).toBeNull()
  expect(nextUp([], new Date())).toBeNull()
})
it('does not count an appointment that has no going-ahead status', () => {
  const missed = { id: 'm', date: '2026-10-12', start_minutes: 960, treatment_duration_minutes: 60, booking_status: 'no_show' }
  expect(nextUp([missed], new Date('2026-10-12T12:00:00Z'))).toBeNull()
})
it('says what a day comes to from the appointments that are going ahead', () => {
  const make = (status, price) => ({ booking_status: status, total_gbp: price })
  expect(daySummary([])).toBe('Free')
  expect(daySummary([make('confirmed', '85.00')])).toBe('1 booking · £85.00')
  expect(daySummary([make('confirmed', '85.00'), make('cancelled', '125.00')])).toBe('1 booking · £85.00')
  expect(daySummary([make('confirmed', '85.00'), make('awaiting_transfer', '90.00')])).toBe('2 bookings · £175.00')
  // A no-show is still an appointment that was made, but it is not worth its price.
  expect(daySummary([make('confirmed', '85.00'), make('no_show', '85.00')])).toBe('2 bookings · £85.00')
  expect(daySummary([make('cancelled', '85.00'), make('cancelled', '90.00')])).toBe('All cancelled')
})
it('offers the way there only for an appointment that is going ahead and has not yet ended, in London time', () => {
  const make = (status, date, start, minutes = 60) => ({ booking_status: status, date, start_minutes: start, treatment_duration_minutes: minutes })
  const noon = new Date('2026-10-12T11:00:00Z') // 12:00 in London
  expect(canNavigateTo(make('confirmed', '2026-10-12', 840), noon)).toBe(true)
  expect(canNavigateTo(make('awaiting_transfer', '2026-10-13', 600), noon)).toBe(true)
  // Under way until 12:30, but over at 12:00 exactly.
  expect(canNavigateTo(make('confirmed', '2026-10-12', 690), noon)).toBe(true)
  expect(canNavigateTo(make('confirmed', '2026-10-12', 660), noon)).toBe(false)
  expect(canNavigateTo(make('confirmed', '2026-10-11', 840), noon)).toBe(false)
  for (const status of ['cancelled', 'completed', 'no_show']) expect(canNavigateTo(make(status, '2026-10-13', 600), noon)).toBe(false)
})

// What every Admin view draws a booking as comes from this one place, so the same booking has the same words and the same colour wherever it is listed.
const booked = (status, payment, method = 'bank_transfer') => ({ booking_status: status, booking_payments: { status: payment, method } })
describe('how a booking is drawn', () => {
  it.each([
    { booking: booked('confirmed', 'paid'), words: 'Confirmed · Paid', variant: 'sage', chip: 'ok' },
    { booking: booked('confirmed', 'approved', 'cash'), words: 'Confirmed · Cash approved', variant: 'sage', chip: 'ok' },
    { booking: booked('confirmed', 'awaiting_transfer'), words: 'Confirmed · Awaiting transfer', variant: 'sand', chip: 'wait' },
    { booking: booked('awaiting_transfer', 'awaiting_transfer'), words: 'Awaiting transfer', variant: 'sand', chip: 'wait' },
    { booking: booked('awaiting_payment_verification', 'awaiting_verification'), words: 'Awaiting payment verification', variant: 'sand', chip: 'needs' },
    { booking: booked('awaiting_cash_approval', 'awaiting_approval', 'cash'), words: 'Awaiting cash approval', variant: 'sand', chip: 'needs' },
    { booking: booked('completed', 'paid'), words: 'Completed · Paid', variant: 'completed', chip: 'done' },
    { booking: booked('no_show', 'paid'), words: 'No show · Paid', variant: 'noshow', chip: 'noshow' },
    { booking: booked('cancelled', 'paid'), words: 'Cancelled', variant: 'cancelled', chip: 'cancel' },
  ])('$words is drawn $variant', ({ booking, words, variant, chip }) => {
    expect(getBookingStatusLabel(booking)).toBe(words)
    expect(getBookingCardVariant(booking)).toBe(variant)
    expect(bookingState(booking)).toMatchObject({ text: words, variant, chip })
  })
  it('keeps a confirmed booking whose money is still being checked or approved as waiting on the Admin: sand, in the words of what is waited for', () => {
    expect(bookingState(booked('confirmed', 'awaiting_verification'))).toMatchObject({ text: 'Awaiting payment verification', variant: 'sand', chip: 'needs' })
    expect(bookingState(booked('confirmed', 'awaiting_approval', 'cash'))).toMatchObject({ text: 'Awaiting cash approval', variant: 'sand', chip: 'needs' })
  })
  it('draws a booking that is going ahead as two pills, the appointment and its money, which move separately', () => {
    expect(bookingState(booked('confirmed', 'awaiting_transfer')).pills).toEqual([{ text: 'Confirmed', chip: 'ok' }, { text: 'Payment awaited', chip: 'wait' }])
    expect(bookingState(booked('confirmed', 'paid')).pills).toEqual([{ text: 'Confirmed', chip: 'ok' }, { text: 'Paid', chip: 'ok' }])
    expect(bookingState(booked('confirmed', 'awaiting_verification')).pills).toEqual([{ text: 'Confirmed', chip: 'ok' }, { text: 'Transfer to check', chip: 'needs' }])
    expect(bookingState(booked('awaiting_transfer', 'awaiting_transfer')).pills).toEqual([{ text: 'Not confirmed yet', chip: 'needs' }, { text: 'Payment awaited', chip: 'wait' }])
    expect(bookingState(booked('completed', 'paid')).pills).toEqual([{ text: 'Completed', chip: 'done' }, { text: 'Paid', chip: 'ok' }])
    expect(bookingState(booked('cancelled', 'paid')).pills).toBeNull()
    expect(bookingState(booked('no_show', 'paid')).pills).toBeNull()
    expect(bookingState({ booking_status: 'confirmed' }).pills).toBeNull()
  })
  it('names a booking that is known only by its status (a clash warning, a repeat) by that status alone', () => {
    expect(getBookingStatusLabel({ booking_status: 'confirmed' })).toBe('Confirmed')
    expect(getBookingStatusLabel({ booking_status: 'awaiting_transfer' })).toBe('Awaiting transfer')
    expect(getBookingStatusLabel({ booking_status: 'completed' })).toBe('Completed')
    expect(getBookingStatusLabel({ booking_status: 'no_show' })).toBe('No show')
    // A booking whose payment record is missing is still said so, as before.
    expect(getBookingStatusLabel({ booking_status: 'confirmed', booking_payments: null })).toBe('Confirmed · Not recorded')
  })
})

describe('whether an appointment has started, in London time', () => {
  const booking = { date: '2026-10-25', start_minutes: 600 }
  it('is false before its start and true from it, using London time on the day the clocks go back', () => {
    expect(hasStarted(booking, new Date('2026-10-25T09:59:00Z'))).toBe(false)
    expect(hasStarted(booking, new Date('2026-10-25T10:00:00Z'))).toBe(true)
    expect(hasStarted(booking, new Date('2026-10-24T23:30:00Z'))).toBe(false)
    expect(hasStarted({ date: '2026-10-24', start_minutes: 1380 }, new Date('2026-10-25T00:30:00Z'))).toBe(true)
  })
})

describe('the extras on a booking card', () => {
  it('lists appointment extras by name, with a quantity above one as × n', () => {
    expect(extrasList({ booking_enhancements: [{ enhancement_name_snapshot: 'Heated table cover', quantity: 1 }, { enhancement_name_snapshot: 'Hot stones', quantity: 2 }] })).toEqual(['Heated table cover', 'Hot stones × 2'])
  })
  it('says whose a per-person extra is only when there is more than one person', () => {
    const extra = { enhancement_name_snapshot: 'Hot stones', quantity: 1 }
    expect(extrasList({ booking_sessions: [{ position: 1, booking_session_enhancements: [extra] }] })).toEqual(['Hot stones'])
    expect(extrasList({ booking_sessions: [{ position: 2, booking_session_enhancements: [] }, { position: 1, booking_session_enhancements: [extra] }] })).toEqual(['Hot stones (person 1)'])
  })
  it('is empty when there are none, or the data is missing', () => {
    expect(extrasList({ booking_enhancements: [], booking_sessions: [{ position: 1, booking_session_enhancements: [] }] })).toEqual([])
    expect(extrasList({})).toEqual([])
  })
})
