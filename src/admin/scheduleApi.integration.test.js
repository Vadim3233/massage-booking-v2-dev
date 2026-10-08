import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { paymentReviewFixture } from '../../tests/paymentReviewFixture.js'
import { createScheduleApi } from './scheduleApi.js'

let f, api, original
const DATE = '2031-09-15'
beforeEach(async () => {
  f = await paymentReviewFixture()
  api = createScheduleApi(f.client)
  original = (await f.admin.from('working_hours').select('*').order('weekday')).data
}, 30000)
afterEach(async () => {
  await f.admin.from('working_hours').upsert(original, { onConflict: 'weekday' })
  await f.admin.from('working_hours_overrides').delete().eq('date', DATE)
  await f.admin.from('calendar_blocks').delete().eq('date', DATE)
  await f?.cleanup()
}, 30000)

describe('schedule control against local Supabase', () => {
  it('lets the Admin change her usual week, and a day off clears its times', async () => {
    await f.authorize()
    const week = await api.weekly()
    expect(week).toHaveLength(7)
    await api.saveWeekly(week.map(day => day.weekday === 6 ? { ...day, available: true, start_minutes: 600, end_minutes: 840, start_mode: 'flexible' } : day.weekday === 7 ? { ...day, available: false } : day))
    const saved = Object.fromEntries((await f.admin.from('working_hours').select('*')).data.map(row => [row.weekday, row]))
    expect(saved[6]).toMatchObject({ available: true, start_minutes: 600, end_minutes: 840 })
    expect(saved[7]).toMatchObject({ available: false, start_minutes: null, end_minutes: null })
  })

  it('manages special days: add, change, list and remove', async () => {
    await f.authorize()
    await api.saveOverride({ date: DATE, available: false, note: 'Holiday' })
    expect((await api.overrides(DATE)).find(item => item.date === DATE)).toMatchObject({ available: false, note: 'Holiday' })
    await api.saveOverride({ date: DATE, available: true, start_minutes: 720, end_minutes: 960, start_mode: 'fixed', fixed_start_minutes: 780, note: 'Half day' })
    expect((await api.overrides(DATE)).find(item => item.date === DATE)).toMatchObject({ available: true, start_minutes: 720, fixed_start_minutes: 780, note: 'Half day' })
    await api.deleteOverride(DATE)
    expect((await api.overrides(DATE)).some(item => item.date === DATE)).toBe(false)
  })

  it('manages blocked time and personal events, recording who made them', async () => {
    await f.authorize()
    await api.createBlock({ kind: 'personal_event', date: DATE, start_minutes: 600, end_minutes: 660, title: 'Dentist', notes: 'Bring forms' })
    const row = (await f.admin.from('calendar_blocks').select('*').eq('date', DATE).single()).data
    expect(row).toMatchObject({ kind: 'personal_event', title: 'Dentist', notes: 'Bring forms', created_by: f.user.id })
    await api.updateBlock(row.id, { kind: 'blocked', date: DATE, start_minutes: 0, end_minutes: 1440, title: '', notes: '' })
    expect((await f.admin.from('calendar_blocks').select('*').eq('id', row.id).single()).data).toMatchObject({ kind: 'blocked', start_minutes: 0, end_minutes: 1440, title: null })
    await api.deleteBlock(row.id)
    expect((await f.admin.from('calendar_blocks').select('id').eq('id', row.id)).data).toEqual([])
  })

  it('warns about live bookings a change would clash with, without moving them', async () => {
    await f.authorize()
    const booking = (await f.admin.from('bookings').select('date,start_minutes,treatment_duration_minutes').eq('id', f.bookings[0].id).single()).data
    const clashes = await api.conflicts(booking.date, 0, 1440)
    expect(clashes.map(item => item.booking_id)).toContain(f.bookings[0].id)
    expect((await f.admin.from('bookings').select('booking_status').eq('id', f.bookings[0].id).single()).data.booking_status).toBe('awaiting_payment_verification')
  })

  it('refuses everyone who is not an Admin, and never shows raw errors', async () => {
    await expect(api.createBlock({ kind: 'blocked', date: DATE, start_minutes: 600, end_minutes: 660, title: '', notes: '' })).rejects.toThrow('Could not save. Please check your connection and try again.')
    await expect(api.conflicts(DATE, 0, 1440)).rejects.toThrow('Could not save')
    expect((await f.admin.from('calendar_blocks').select('id').eq('date', DATE)).data).toEqual([])
  })

  it('lets the database reject an impossible day even if the screen did not', async () => {
    await f.authorize()
    await expect(api.saveOverride({ date: DATE, available: true, start_minutes: 900, end_minutes: 600, start_mode: 'flexible' })).rejects.toThrow('Could not save')
  })
})
