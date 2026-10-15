import { describe, expect, it } from 'vitest'
import { bookingsLine, dayState, hoursChanged, isDate, isDirty, settingsLine, workingDay } from './daySettings.js'

// 2031-05-07 is a Wednesday, weekday 3.
const wednesday = { weekday: 3, available: true, start_minutes: 720, end_minutes: 1260, start_mode: 'fixed', fixed_start_minutes: 900, anchor_release_minutes: 1020, schedule_mode: 'flexible' }
const hours = [wednesday]

describe('a date in the address', () => {
  it('accepts a real date and nothing else', () => {
    expect(isDate('2031-05-07')).toBe(true)
    expect(isDate('2031-02-30')).toBe(false)
    expect(isDate('2031-5-7')).toBe(false)
    expect(isDate('')).toBe(false)
    expect(isDate(undefined)).toBe(false)
    expect(isDate('2031-05-07T10:00')).toBe(false)
  })
})

describe('what a date holds', () => {
  it("follows the usual week when the date has no settings of its own", () => {
    const state = dayState('2031-05-07', { overrides: [], hours })
    expect(state.special).toBe(false)
    expect(state.saved).toEqual({ available: true, start_minutes: 720, end_minutes: 1260, start_mode: 'fixed', fixed_start_minutes: 900, anchor_release_minutes: 1020, schedule_mode: 'flexible', note: '' })
    expect(state.usual.start_minutes).toBe(720)
  })
  it("uses the date's own settings, note included, instead of the usual week's", () => {
    const own = { date: '2031-05-07', available: true, start_minutes: 600, end_minutes: 900, start_mode: 'flexible', fixed_start_minutes: null, anchor_release_minutes: null, schedule_mode: 'chain', note: 'Short day' }
    const state = dayState('2031-05-07', { overrides: [own], hours })
    expect(state.special).toBe(true)
    expect(state.saved).toEqual({ available: true, start_minutes: 600, end_minutes: 900, start_mode: 'flexible', fixed_start_minutes: null, anchor_release_minutes: null, schedule_mode: 'chain', note: 'Short day' })
    // What the usual week says is still known, so the screen can say it and go back to it.
    expect(state.usual.schedule_mode).toBe('flexible')
  })
  it('reads a day from a database that has no release time or schedule mode yet as having neither', () => {
    const older = { date: '2031-05-07', available: true, start_minutes: 600, end_minutes: 900, start_mode: 'fixed', fixed_start_minutes: 660, note: null }
    expect(dayState('2031-05-07', { overrides: [older], hours: [] }).saved).toMatchObject({ anchor_release_minutes: null, schedule_mode: 'chain', note: '' })
    const olderWeek = { weekday: 3, available: true, start_minutes: 600, end_minutes: 900, start_mode: 'flexible', fixed_start_minutes: null }
    expect(dayState('2031-05-07', { overrides: [], hours: [olderWeek] }).saved).toMatchObject({ anchor_release_minutes: null, schedule_mode: 'chain' })
  })
  it('is a day off when the usual week has no such weekday, or has it off', () => {
    expect(dayState('2031-05-08', { overrides: [], hours }).saved.available).toBe(false)
    expect(dayState('2031-05-07', { overrides: [], hours: [{ ...wednesday, available: false }] }).saved.available).toBe(false)
  })
})

describe('the settings in one line', () => {
  const day = { available: true, start_minutes: 720, end_minutes: 1200, start_mode: 'fixed', fixed_start_minutes: 900, anchor_release_minutes: null, schedule_mode: 'chain' }
  it('says the hours, the schedule mode and the first appointment', () => {
    expect(settingsLine(day)).toBe('Working 12:00–20:00 · Chain · First appointment 15:00')
    expect(settingsLine({ ...day, schedule_mode: 'flexible' })).toBe('Working 12:00–20:00 · Flexible · First appointment 15:00')
    expect(settingsLine({ ...day, start_mode: 'flexible', fixed_start_minutes: null })).toBe('Working 12:00–20:00 · Chain · First appointment: any time')
  })
  it('says when the first appointment is released', () => {
    expect(settingsLine({ ...day, anchor_release_minutes: 1020 })).toBe('Working 12:00–20:00 · Chain · First appointment 15:00, released 17:00 the day before')
    // A release time means nothing without a set first appointment.
    expect(settingsLine({ ...day, start_mode: 'flexible', anchor_release_minutes: 1020 })).toBe('Working 12:00–20:00 · Chain · First appointment: any time')
  })
  it('says a day off plainly', () => {
    expect(settingsLine({ available: false })).toBe('Not a working day')
  })
})

describe('the bookings in one line', () => {
  const booking = (start, minutes, status = 'confirmed') => ({ start_minutes: start, treatment_duration_minutes: minutes, booking_status: status })
  it('says there are none', () => {
    expect(bookingsLine([])).toBe('No bookings')
  })
  it('counts the bookings in the day\'s run and says from when to when they run, whatever order they are given in', () => {
    expect(bookingsLine([booking(1020, 60), booking(780, 90), booking(900, 60)])).toBe('3 bookings · 13:00–18:00')
    expect(bookingsLine([booking(900, 60)])).toBe('1 booking · 15:00–16:00')
  })
  it('leaves out bookings that are not in the run: cancelled and no-show', () => {
    expect(bookingsLine([booking(600, 60, 'cancelled'), booking(660, 60, 'no_show')])).toBe('No bookings')
    expect(bookingsLine([booking(600, 60, 'cancelled'), booking(900, 60, 'awaiting_transfer'), booking(1020, 60, 'completed')])).toBe('2 bookings · 15:00–18:00')
  })
})

describe('whether anything has changed', () => {
  const saved = { available: true, start_minutes: 600, end_minutes: 1200, start_mode: 'flexible', fixed_start_minutes: null, anchor_release_minutes: null, schedule_mode: 'chain', note: '' }
  it('is not a change when nothing differs, or only spaces in the note', () => {
    expect(isDirty(saved, { ...saved })).toBe(false)
    expect(isDirty({ ...saved, note: 'Short' }, { ...saved, note: ' Short ' })).toBe(false)
  })
  it('is a change when the hours, the mode, the first appointment, the release time, the note or the day off differ', () => {
    expect(isDirty(saved, { ...saved, start_minutes: 630 })).toBe(true)
    expect(isDirty(saved, { ...saved, schedule_mode: 'flexible' })).toBe(true)
    expect(isDirty(saved, { ...saved, start_mode: 'fixed', fixed_start_minutes: 900 })).toBe(true)
    expect(isDirty({ ...saved, start_mode: 'fixed', fixed_start_minutes: 900 }, { ...saved, start_mode: 'fixed', fixed_start_minutes: 900, anchor_release_minutes: 1020 })).toBe(true)
    expect(isDirty(saved, { ...saved, note: 'Short' })).toBe(true)
    expect(isDirty(saved, { ...saved, available: false })).toBe(true)
  })
  it('ignores what a day off or a flexible start would not keep anyway', () => {
    const off = { available: false, start_minutes: null, end_minutes: null, start_mode: 'flexible', fixed_start_minutes: null, anchor_release_minutes: null, schedule_mode: 'chain', note: '' }
    expect(isDirty(off, { ...off, start_minutes: 600, schedule_mode: 'flexible', anchor_release_minutes: 1020 })).toBe(false)
    expect(isDirty(saved, { ...saved, fixed_start_minutes: 900, anchor_release_minutes: 1020 })).toBe(false)
  })
  it('tells whether the working hours themselves changed, which is what can strand a booking', () => {
    expect(hoursChanged(saved, { ...saved, schedule_mode: 'flexible', start_mode: 'fixed', fixed_start_minutes: 900, note: 'x' })).toBe(false)
    expect(hoursChanged(saved, { ...saved, start_minutes: 630 })).toBe(true)
    expect(hoursChanged(saved, { ...saved, end_minutes: 1170 })).toBe(true)
    expect(hoursChanged(saved, { ...saved, available: false })).toBe(true)
    expect(hoursChanged({ ...saved, available: false }, saved)).toBe(true)
  })
})

describe('switching a day back on', () => {
  it('starts from what the weekday usually is, keeping the note', () => {
    const usual = { available: true, start_minutes: 720, end_minutes: 1260, start_mode: 'fixed', fixed_start_minutes: 900, anchor_release_minutes: 1020, schedule_mode: 'flexible' }
    expect(workingDay(usual, 'Hello')).toEqual({ ...usual, note: 'Hello' })
  })
  it('starts from ordinary hours when the weekday is usually off', () => {
    expect(workingDay({ available: false }, '')).toEqual({ available: true, start_minutes: 600, end_minutes: 1200, start_mode: 'flexible', fixed_start_minutes: null, anchor_release_minutes: null, schedule_mode: 'chain', note: '' })
  })
})
