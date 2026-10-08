import { describe, expect, it } from 'vitest'
import { clock, createScheduleApi, timeOptions, validateBlock, validateHours } from './scheduleApi.js'

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
    const block = (overrides = {}) => ({ kind: 'blocked', title: '', date: '2031-01-01', start_minutes: 720, end_minutes: 780, ...overrides })
    expect(validateBlock(block())).toBe('')
    expect(validateBlock(block({ date: '' }))).toBe('Choose a date.')
    expect(validateBlock(block({ kind: 'personal_event', title: '  ' }))).toBe('Give the personal event a name.')
    expect(validateBlock(block({ end_minutes: 720 }))).toBe('The end time must be after the start time.')
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
    return { calls, from: chain, rpc: async () => result, auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } } }) } }
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
  it('records who created a block and tidies the text', async () => {
    const client = recorder()
    await createScheduleApi(client).createBlock({ kind: 'personal_event', date: '2031-01-03', start_minutes: 600, end_minutes: 660, title: ' Dentist ', notes: '' })
    expect(client.calls[0].steps[0][1][0]).toMatchObject({ title: 'Dentist', notes: null, created_by: 'admin-1' })
  })
  it('never shows a technical error', async () => {
    const client = recorder({ data: null, error: { message: 'violates check constraint "working_hours_fixed_mode_valid"' } })
    await expect(createScheduleApi(client).weekly()).rejects.toThrow('Could not save. Please check your connection and try again.')
  })
})
