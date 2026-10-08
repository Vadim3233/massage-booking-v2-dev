import { describe, expect, it } from 'vitest'
import { clock, createScheduleApi, daysBetween, groupBlocks, timeOptions, validateBlock, validateHours } from './scheduleApi.js'

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
    await createScheduleApi(client).saveWeekly([{ weekday: 6, available: false, start_minutes: 600, end_minutes: 900, start_mode: 'fixed', fixed_start_minutes: 600 }])
    const [method, [rows]] = client.calls[0].steps[0]
    expect(method).toBe('upsert')
    expect(rows).toEqual([{ weekday: 6, available: false, start_minutes: null, end_minutes: null, start_mode: 'flexible', fixed_start_minutes: null }])
  })
  it('keeps the first-appointment time only for a set start', async () => {
    const client = recorder()
    await createScheduleApi(client).saveOverride({ date: '2031-01-02', available: true, start_minutes: 600, end_minutes: 900, start_mode: 'flexible', fixed_start_minutes: 660, note: ' Half day ' })
    expect(client.calls[0].steps[0][1][0]).toMatchObject({ date: '2031-01-02', fixed_start_minutes: null, note: 'Half day' })
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
