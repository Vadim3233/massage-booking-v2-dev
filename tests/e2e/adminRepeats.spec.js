import { test, expect } from '@playwright/test'
import { newBookingFixture } from '../newBookingFixture.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'
import { today, shiftDate } from '../../src/admin/calendarPresentation.js'

let f
const SETTING = 'series_payment_reminder_days'
test.beforeEach(async () => { f = await newBookingFixture(37) })
test.afterEach(async () => {
  const series = (await f.admin.from('booking_series').select('id').eq('client_id', f.recipient.id)).data || []
  for (const row of series) await f.admin.from('event_outbox').delete().eq('aggregate_id', row.id)
  await f.admin.from('booking_series').delete().eq('client_id', f.recipient.id)
  await f.admin.from('business_settings').delete().eq('key', SETTING)
  await f.admin.from('working_hours_overrides').delete().eq('date', shiftDate(f.date, 7))
  await f?.cleanup()
})

async function login(page, route) {
  await page.goto(route)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
async function next(page) { await page.getByRole('button', { name: 'Continue', exact: true }).click() }

test('a booking can be made to repeat weekly, the slot is held, and the repeat is managed from the client', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page, '/admin/day')
  await expect(page.getByRole('button', { name: '+ New booking', exact: true })).toBeVisible()
  await page.getByLabel('Calendar date', { exact: true }).fill(f.date)
  await page.getByRole('button', { name: '+ New booking', exact: true }).click()
  await page.getByLabel('Find a client').fill(f.recipient.email)
  await page.getByRole('button', { name: new RegExp(f.recipient.first_name) }).click()
  await page.getByRole('combobox', { name: 'Service area', exact: true }).selectOption(f.ids.area)
  await next(page)
  await page.getByRole('combobox', { name: 'Treatment', exact: true }).selectOption(f.ids.service)
  await page.getByLabel('Recipient name 1', { exact: true }).fill('Regular Client')
  await next(page)
  await page.getByRole('group', { name: 'Available times' }).getByRole('button').first().click()
  await next(page)

  const repeat = page.getByRole('checkbox', { name: /Repeat every/ })
  await repeat.check()
  await expect(page.getByText('Only the next appointment is asked to be paid')).toBeVisible()
  const end = shiftDate(f.date, 21)
  await page.getByLabel('Stop repeating after (optional)').fill(end)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await next(page)
  await expect(page.getByText(/Repeats every .* until/)).toBeVisible()
  await page.getByRole('button', { name: 'Create booking', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText('Part of a repeating booking')

  const series = await unwrap(f.admin.from('booking_series').select('id,status,end_date,first_date').eq('client_id', f.recipient.id))
  expect(series).toHaveLength(1)
  expect(series[0]).toMatchObject({ status: 'active', end_date: end, first_date: f.date })
  const holds = await unwrap(f.admin.from('calendar_blocks').select('date').eq('series_id', series[0].id).order('date'))
  expect(holds.map(row => row.date)).toEqual([shiftDate(f.date, 7), shiftDate(f.date, 14), shiftDate(f.date, 21)])

  // The weekly slot shows on the calendar as held, and cannot be edited like ordinary blocked time.
  await page.getByRole('button', { name: 'Close details', exact: true }).click()
  await page.getByLabel('Calendar date', { exact: true }).fill(shiftDate(f.date, 7))
  await expect(page.getByText(/Held for .* \(repeat\)/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Held for/ })).toHaveCount(0)

  // The client's page lists the repeat; a date can be skipped and put back, and the repeat paused, resumed and stopped.
  await page.goto(`/admin/clients/${f.recipient.id}`)
  const section = page.getByRole('region', { name: 'Repeating bookings' })
  await expect(section).toContainText('Every')
  await expect(section).toContainText('until')
  await section.getByLabel('Skip a date').fill(shiftDate(f.date, 14))
  await section.getByRole('button', { name: 'Skip this date' }).click()
  await expect(section.getByRole('list', { name: 'Dates not booked' })).toContainText('Skipped')
  expect((await unwrap(f.admin.from('calendar_blocks').select('date').eq('series_id', series[0].id))).map(row => row.date)).not.toContain(shiftDate(f.date, 14))
  await section.getByRole('button', { name: 'Put back' }).click()
  await expect(section.getByRole('list', { name: 'Dates not booked' })).toHaveCount(0)
  await section.getByRole('button', { name: 'Pause' }).click()
  await expect(section).toContainText('Paused')
  expect(await unwrap(f.admin.from('calendar_blocks').select('id').eq('series_id', series[0].id))).toHaveLength(0)
  await section.getByRole('button', { name: 'Resume' }).click()
  await expect(section).toContainText('Repeating')
  await section.getByRole('button', { name: 'Stop repeating' }).click()
  await section.getByRole('button', { name: 'Yes, stop repeating' }).click()
  await expect(section).toContainText('Ended')
  expect(await unwrap(f.admin.from('calendar_blocks').select('id').eq('series_id', series[0].id))).toHaveLength(0)
})

test('the daily job books the next session and asks the client to pay for it', async () => {
  await unwrap(f.admin.from('working_hours_overrides').upsert({ date: shiftDate(f.date, 7), available: true, start_minutes: 0, end_minutes: 1440, start_mode: 'flexible' }, { onConflict: 'date' }))
  // Make the first booking and the repeat through the Admin's own sign-in, exactly as the screen does.
  const request = {
    client_id: f.recipient.id, saved_address_id: f.addresses[0].id, service_area_id: f.ids.area,
    sessions: [{ service_id: f.ids.service, duration_minutes: 60, recipient_name: 'Regular Client', preference_ids: [] }],
    enhancement_ids: [], date: f.date, start_minutes: 600, payment_arrangement: 'bank_pending', note: null,
  }
  const made = await unwrap(f.client.rpc('admin_create_series', { p_request: request, p_end_date: null, p_request_id: crypto.randomUUID() }))
  expect(made).toHaveLength(1)
  // Next session is 7 days after the first, which is more than the reminder window away from today.
  expect(today() < shiftDate(f.date, 7)).toBe(true)
  await unwrap(f.admin.from('business_settings').upsert({ key: SETTING, value: 60 }, { onConflict: 'key' }))
  const result = await unwrap(f.admin.rpc('run_series_maintenance'))
  expect(result.made).toBeGreaterThanOrEqual(1)
  const later = await unwrap(f.admin.from('bookings').select('id,date,booking_status,series_id').eq('series_id', made[0].series_id).order('date'))
  expect(later.map(row => row.date).slice(0, 2)).toEqual([f.date, shiftDate(f.date, 7)])
  expect(later[1]).toMatchObject({ booking_status: 'confirmed' })
  const messages = await unwrap(f.admin.from('notification_deliveries').select('audience,recipient,title,event_id').eq('recipient', f.recipient.email))
  expect(messages.filter(row => row.title === 'Time to pay for your next appointment').length).toBeGreaterThanOrEqual(1)
  expect(messages.some(row => row.title === 'Your appointment is booked')).toBe(true)
})

test('the number of days before a session that payment is asked for is a setting', async ({ page }) => {
  await login(page, '/admin/settings/rules')
  const field = page.getByLabel('Ask for payment this many days before each repeat session')
  await expect(field).toHaveValue('7')
  await field.fill('0')
  await expect(page.getByText('Enter a number of days from 1 to 30.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await field.fill('10')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible()
  expect((await f.admin.from('business_settings').select('value').eq('key', SETTING).single()).data.value).toBe(10)
})
