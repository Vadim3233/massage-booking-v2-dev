import { describe, expect, it } from 'vitest'
import { clashNote, unusualNotes } from './times.js'

// A working day, 14:30 to 17:30, with Amelia booked 14:30 to 15:30.
const day = (patch = {}) => ({
  working: { open: true, start: 870, end: 1050 }, buffer_minutes: 60,
  booked: [{ start: 870, end: 930, label: 'Amelia Hart', kind: 'booking' }],
  blocks: [], ...patch,
})

describe('what is in the way of a time', () => {
  it('names the appointment a time would overlap', () => {
    expect(clashNote(900, 60, day())).toBe('Clashes with the 14:30–15:30 appointment for Amelia Hart.')
    expect(clashNote(840, 60, day())).toBe('Clashes with the 14:30–15:30 appointment for Amelia Hart.')
  })
  it('says a client is booking when it is a time held for one', () => {
    expect(clashNote(600, 60, day({ booked: [{ start: 600, end: 660, label: null, kind: 'hold' }] }))).toBe('Another client is in the middle of booking 10:00–11:00.')
  })
  it('says nothing when the time is free, even right beside an appointment', () => {
    expect(clashNote(930, 60, day())).toBe('')
    expect(clashNote(780, 60, day())).toBe('')
  })
})

describe('why a free time is still unusual', () => {
  it('says how short the gap after an appointment is', () => {
    expect(unusualNotes(960, 60, day())).toEqual(['Only 30 minutes after the 14:30 appointment ends (your usual gap is 60 minutes).'])
    expect(unusualNotes(930, 60, day())).toEqual(['Straight after the 14:30 appointment ends (your usual gap is 60 minutes).'])
  })
  it('says how short the gap before an appointment is', () => {
    expect(unusualNotes(810, 60, day())).toEqual(['Outside your working hours (14:30–17:30).', 'Straight before the 14:30 appointment starts (your usual gap is 60 minutes).'])
    expect(unusualNotes(780, 60, day())).toEqual(['Outside your working hours (14:30–17:30).', 'Only 30 minutes before the 14:30 appointment starts (your usual gap is 60 minutes).'])
  })
  it('says when it is outside working hours, or not a working day', () => {
    expect(unusualNotes(1020, 60, day())).toEqual(['Outside your working hours (14:30–17:30).'])
    expect(unusualNotes(750, 60, day())).toEqual(['Outside your working hours (14:30–17:30).'])
    expect(unusualNotes(600, 60, day({ working: { open: false, start: null, end: null } }))).toContain('This is not one of your working days.')
  })
  it('names a blocked time or personal event it falls in', () => {
    expect(unusualNotes(990, 60, day({ blocks: [{ start: 960, end: 1020, title: 'Dentist' }] }))).toEqual(['During "Dentist" (16:00–17:00).'])
  })
  it('gives several reasons together', () => {
    const notes = unusualNotes(960, 120, day({ blocks: [{ start: 960, end: 990, title: 'Dentist' }] }))
    expect(notes).toEqual(['Outside your working hours (14:30–17:30).', 'Only 30 minutes after the 14:30 appointment ends (your usual gap is 60 minutes).', 'During "Dentist" (16:00–16:30).'])
  })
  it('warns that a time kept free for a repeating client may lose its repeat, unless the time is taken on top of it', () => {
    const repeat = { start: 1050, end: 1110, title: 'Held for Amelia Hart (repeat)', series: true }
    expect(unusualNotes(780, 60, day({ blocks: [repeat] }))).toContain("A repeating client's time (17:30–18:30) is kept free this day. A booking at an unusual time may stop that week's repeat.")
    expect(unusualNotes(1050, 60, day({ blocks: [repeat] }))).toEqual(['Outside your working hours (14:30–17:30).', 'During "Held for Amelia Hart (repeat)" (17:30–18:30).'])
  })
  it('still says something when nothing is wrong except that it is not a usual time', () => {
    expect(unusualNotes(1020, 30, day({ working: { open: true, start: 870, end: 1200 } }))).toEqual(['The booking page only offers times just before your first appointment or just after your last one.'])
    expect(unusualNotes(900, 60, day({ booked: [] }))).toEqual(['Not your usual start time for this day.'])
  })
})
