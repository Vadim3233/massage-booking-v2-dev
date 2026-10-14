import { describe, expect, it } from 'vitest'
import { clock, createScheduleApi, daysBetween, groupBlocks, hoursLine, timeOptions, usualHoursFor, validateBlock, validateHours, weekdayOf } from './scheduleApi.js'

describe('time choices', () => {
  it('offers whole and half hours, with midnight only as an end time', () => {
    expect(timeOptions(false)[0]).toBe(0)
    expect(timeOptions(false).at(-1)).toBe(1410)
    expect(timeOptions(true).at(-1)).toBe(1440)
    expect(timeOptions(false).every(minutes => minutes % 30 === 0)).toBe(true)
    expect(clock(870)).toBe('14:30')
    expect(clock(1440)).toBe('24:00')
  })
})

describe('checking hours before saving', () => {
  const day = (overrides = {}) => ({ available: true, start_minutes: 600, end_minutes: 1200, start_mode: 'flexible', fixed_start_minutes: null, ...overrides })
  it('accepts a normal day and a day off', () => {
    expect(validateHours(day())).toBe('')
    expect(validateHours({ available: false })).toBe('')
  })
  it('explains what is wrong in plain words', () => {
    expect(validateHours(day({ end_minutes: 600 }))).toBe('The end time must be after the start time.')
    expect(validateHours(day({ start_minutes: null }))).toBe('Choose a start and an end time.')
    expect(validateHours(day({ start_mode: 'fixed', fixed_start_minutes: null }))).toBe('Choose the time of the first appointment.')
    expect(validateHours(day({ start_mode: 'fixed', fixed_start_minutes: 570 }))).toBe('The first appointment must be inside your working hours.')
    expect(validateHours(day({ start_mode: 'fixed', fixed_start_minutes: 1200 }))).toBe('The first appointment must be inside your working hours.')
    expect(validateHours(day({ start_mode: 'fixed', fixed_start_minutes: 660 }))).toBe('')
  })
  it('lets a release time go only with a first appointment at a set time', () => {
    expect(validateHours(day({ start_mode: 'fixed', fixed_start_minutes: 900, anchor_release_minutes: 1020 }))).toBe('')
    expect(validateHours(day({ start_mode: 'fixed', fixed_start_minutes: 900, anchor_release_minutes: 0 }))).toBe('')
    expect(validateHours(day({ start_mode: 'flexible', anchor_release_minutes: 1020 }))).toBe('A release time needs a first appointment at a set time.')
    // A day off carries nothing, so a leftover release time on one is not a mistake to report.
    expect(validateHours({ available: false, anchor_release_minutes: 1020 })).toBe('')
  })
  it('checks blocked time', () => {
    const block = (overrides = {}) => ({ kind: 'blocked', title: '', start_date: '2031-01-01', end_date: '2031-01-01', start_minutes: 720, end_minutes: 780, ...overrides })
    expect(validateBlock(block())).toBe('')
    expect(validateBlock(block({ start_date: '' }))).toBe('Choose a date.')
    expect(validateBlock(block({ end_date: '' }))).toBe('Choose an end date.')
    expect(validateBlock(block({ kind: 'personal_event', title: '  ' }))).toBe('Give the personal event a name.')
    expect(validateBlock(block({ end_minutes: 720 }))).toBe('The end time must be after the start time.')
    // Over several days the end time may be earlier in the day than the start time.
    expect(validateBlock(block({ end_date: '2031-01-04', start_minutes: 840, end_minutes: 600 }))).toBe('')
    expect(validateBlock(block({ end_date: '2030-12-31' }))).toBe('The end date cannot be before the start date.')
    expect(validateBlock(block({ end_date: '2032-06-01' }))).toBe('A block can cover up to a year.')
    expect(daysBetween('2031-03-28', '2031-04-02')).toBe(5)
  })
})

describe('a special day starts from the usual week', () => {
  const week = [
    { weekday: 1, available: true, start_minutes: 600, end_minutes: 1200, start_mode: 'flexible', fixed_start_minutes: null, anchor_release_minutes: null, schedule_mode: 'chain' },
    { weekday: 3, available: true, start_minutes: 720, end_minutes: 1260, start_mode: 'fixed', fixed_start_minutes: 900, anchor_release_minutes: null, schedule_mode: 'chain' },
    { weekday: 4, available: false, start_minutes: null, end_minutes: null, start_mode: 'flexible', fixed_start_minutes: null, anchor_release_minutes: null, schedule_mode: 'chain' },
    { weekday: 5, available: true, start_minutes: 600, end_minutes: 1200, start_mode: 'fixed', fixed_start_minutes: 900, anchor_release_minutes: 1020, schedule_mode: 'flexible' },
  ]
  it('knows the weekday of a date, with Monday as 1 and Sunday as 7', () => {
    expect(weekdayOf('2026-10-12')).toBe(1)
    expect(weekdayOf('2026-10-14')).toBe(3)
    expect(weekdayOf('2026-10-17')).toBe(6)
    expect(weekdayOf('2026-10-18')).toBe(7)
  })
  it("gives that weekday's hours and first appointment", () => {
    expect(usualHoursFor('2026-10-12', week)).toEqual({ available: true, start_minutes: 600, end_minutes: 1200, start_mode: 'flexible', fixed_start_minutes: null, anchor_release_minutes: null, schedule_mode: 'chain' })
    expect(usualHoursFor('2026-10-14', week)).toEqual({ available: true, start_minutes: 720, end_minutes: 1260, start_mode: 'fixed', fixed_start_minutes: 900, anchor_release_minutes: null, schedule_mode: 'chain' })
  })
  it('hands its release time and schedule mode to a special day too, so the special day starts from them', () => {
    expect(usualHoursFor('2026-10-16', week)).toEqual({ available: true, start_minutes: 600, end_minutes: 1200, start_mode: 'fixed', fixed_start_minutes: 900, anchor_release_minutes: 1020, schedule_mode: 'flexible' })
    // A week read from a database that has neither yet has no release time, and is a chain.
    const older = { weekday: 5, available: true, start_minutes: 600, end_minutes: 1200, start_mode: 'fixed', fixed_start_minutes: 900 }
    expect(usualHoursFor('2026-10-16', [older]).anchor_release_minutes).toBeNull()
    expect(usualHoursFor('2026-10-16', [older]).schedule_mode).toBe('chain')
  })
  it('gives a day off for a weekday that is off or missing, and when the week is not known', () => {
    expect(usualHoursFor('2026-10-15', week).available).toBe(false)
    expect(usualHoursFor('2026-10-17', week).available).toBe(false)
    expect(usualHoursFor('2026-10-14', null).available).toBe(false)
    expect(usualHoursFor('2026-10-15', week).anchor_release_minutes).toBeNull()
    expect(usualHoursFor('2026-10-15', week).schedule_mode).toBe('chain')
  })
  it('describes a day in one line, with the first appointment only when it is set to a time', () => {
    expect(hoursLine({ available: false })).toBe('Day off')
    expect(hoursLine(week[0])).toBe('10:00–20:00')
    expect(hoursLine(week[1])).toBe('12:00–21:00, first appointment at 15:00')
  })
  it('says when the first appointment is released, in the same line', () => {
    expect(hoursLine({ ...week[3], schedule_mode: 'chain' })).toBe('10:00–20:00, first appointment at 15:00 (released at 17:00 the day before)')
    // A release time means nothing without a set first appointment, so it is not described for one.
    expect(hoursLine({ ...week[0], anchor_release_minutes: 1020 })).toBe('10:00–20:00')
  })
  it('says when a day is flexible, and says nothing for a chain day', () => {
    expect(hoursLine({ ...week[0], schedule_mode: 'flexible' })).toBe('10:00–20:00, flexible schedule')
    expect(hoursLine(week[3])).toBe('10:00–20:00, first appointment at 15:00 (released at 17:00 the day before), flexible schedule')
    expect(hoursLine({ ...week[0], schedule_mode: 'chain' })).toBe('10:00–20:00')
    expect(hoursLine(week[0])).toBe('10:00–20:00')
    expect(hoursLine({ available: false, schedule_mode: 'flexible' })).toBe('Day off')
  })
})

describe('what is sent to the database', () => {
  function recorder(result = { data: [], error: null }) {
    const calls = []
    const chain = table => {
      const call = { table, steps: [] }
      calls.push(call)
      const proxy = new Proxy({}, { get: (_, method) => method === 'then' ? resolve => resolve(result) : (...args) => { call.steps.push([method, args]); return proxy } })
      return proxy
    }
    const rpcCalls = []
    return { calls, rpcCalls, from: chain, rpc: async (name, args) => { rpcCalls.push([name, args]); return result }, auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } } }) } }
  }
  it('clears the times when a day is switched off, so the database rule is met', async () => {
    const client = recorder()
    await createScheduleApi(client).saveWeekly([{ weekday: 6, available: false, start_minutes: 600, end_minutes: 900, start_mode: 'fixed', fixed_start_minutes: 600, anchor_release_minutes: 1020, schedule_mode: 'flexible' }])
    const [method, [rows]] = client.calls[0].steps[0]
    expect(method).toBe('upsert')
    expect(rows).toEqual([{ weekday: 6, available: false, start_minutes: null, end_minutes: null, start_mode: 'flexible', fixed_start_minutes: null, anchor_release_minutes: null, schedule_mode: 'chain' }])
  })
  it('sends the schedule mode of a working day, and a chain when it is not flexible or not known', async () => {
    const weekly = recorder()
    const day = { available: true, start_minutes: 600, end_minutes: 1200, start_mode: 'flexible' }
    await createScheduleApi(weekly).saveWeekly([
      { weekday: 1, ...day, schedule_mode: 'flexible' },
      { weekday: 2, ...day, schedule_mode: 'chain' },
      { weekday: 3, ...day },
      { weekday: 4, ...day, schedule_mode: 'loose' },
    ])
    expect(weekly.calls[0].steps[0][1][0].map(row => row.schedule_mode)).toEqual(['flexible', 'chain', 'chain', 'chain'])
    const special = recorder()
    await createScheduleApi(special).saveOverride({ date: '2031-01-02', ...day, schedule_mode: 'flexible', note: '' })
    expect(special.calls[0].steps[0][1][0]).toMatchObject({ schedule_mode: 'flexible' })
    // A flexible special day that becomes a day off is saved as a plain day off.
    const off = recorder()
    await createScheduleApi(off).saveOverride({ date: '2031-01-03', available: false, schedule_mode: 'flexible', note: '' })
    expect(off.calls[0].steps[0][1][0]).toMatchObject({ available: false, schedule_mode: 'chain' })
  })
  it('keeps the first-appointment time only for a set start', async () => {
    const client = recorder()
    await createScheduleApi(client).saveOverride({ date: '2031-01-02', available: true, start_minutes: 600, end_minutes: 900, start_mode: 'flexible', fixed_start_minutes: 660, anchor_release_minutes: 1020, note: ' Half day ' })
    expect(client.calls[0].steps[0][1][0]).toMatchObject({ date: '2031-01-02', fixed_start_minutes: null, anchor_release_minutes: null, note: 'Half day' })
  })
  it('keeps the release time for a set start, on the usual week and on a special day', async () => {
    const weekly = recorder()
    await createScheduleApi(weekly).saveWeekly([
      { weekday: 3, available: true, start_minutes: 600, end_minutes: 1200, start_mode: 'fixed', fixed_start_minutes: 900, anchor_release_minutes: 1020 },
      { weekday: 4, available: true, start_minutes: 600, end_minutes: 1200, start_mode: 'fixed', fixed_start_minutes: 900 },
    ])
    expect(weekly.calls[0].steps[0][1][0].map(row => row.anchor_release_minutes)).toEqual([1020, null])
    const special = recorder()
    await createScheduleApi(special).saveOverride({ date: '2031-01-02', available: true, start_minutes: 600, end_minutes: 1200, start_mode: 'fixed', fixed_start_minutes: 900, anchor_release_minutes: 0, note: '' })
    expect(special.calls[0].steps[0][1][0]).toMatchObject({ start_mode: 'fixed', fixed_start_minutes: 900, anchor_release_minutes: 0, note: null })
  })
  it('reads the release time and the schedule mode back, so that saving a day never wipes one it did not show', async () => {
    const weekly = recorder()
    await createScheduleApi(weekly).weekly()
    expect(weekly.calls[0].table).toBe('working_hours')
    expect(weekly.calls[0].steps[0][1][0].split(',')).toEqual(expect.arrayContaining(['anchor_release_minutes', 'schedule_mode']))
    const special = recorder()
    await createScheduleApi(special).overrides('2031-01-01')
    expect(special.calls[0].table).toBe('working_hours_overrides')
    expect(special.calls[0].steps[0][1][0].split(',')).toEqual(expect.arrayContaining(['anchor_release_minutes', 'schedule_mode']))
  })
  it('saves a block over a range in one command and tidies the text', async () => {
    const client = recorder()
    await createScheduleApi(client).saveBlock(null, { kind: 'personal_event', start_date: '2031-01-03', end_date: '2031-01-05', start_minutes: 600, end_minutes: 660, title: ' Dentist ', notes: '' })
    expect(client.rpcCalls[0]).toEqual(['admin_save_block_range', { p_group_id: null, p_kind: 'personal_event', p_title: 'Dentist', p_notes: null,
      p_start_date: '2031-01-03', p_start_minutes: 600, p_end_date: '2031-01-05', p_end_minutes: 660 }])
  })
  it('joins the days of one block back into a single block', () => {
    const rows = [
      { group_id: 'g1', kind: 'blocked', title: 'Holiday', notes: null, date: '2031-08-05', start_minutes: 0, end_minutes: 1440 },
      { group_id: 'g1', kind: 'blocked', title: 'Holiday', notes: null, date: '2031-08-04', start_minutes: 840, end_minutes: 1440 },
      { group_id: 'g1', kind: 'blocked', title: 'Holiday', notes: null, date: '2031-08-06', start_minutes: 0, end_minutes: 600 },
      { group_id: 'g2', kind: 'personal_event', title: 'Dentist', notes: 'Forms', date: '2031-09-01', start_minutes: 600, end_minutes: 660 },
    ]
    expect(groupBlocks(rows)).toEqual([
      { group_id: 'g1', kind: 'blocked', title: 'Holiday', notes: '', start_date: '2031-08-04', start_minutes: 840, end_date: '2031-08-06', end_minutes: 600 },
      { group_id: 'g2', kind: 'personal_event', title: 'Dentist', notes: 'Forms', start_date: '2031-09-01', start_minutes: 600, end_date: '2031-09-01', end_minutes: 660 },
    ])
  })
  it('never shows a technical error', async () => {
    const client = recorder({ data: null, error: { message: 'violates check constraint "working_hours_fixed_mode_valid"' } })
    await expect(createScheduleApi(client).weekly()).rejects.toThrow('Could not save. Please check your connection and try again.')
  })
})
