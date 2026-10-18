import { test, expect } from '@playwright/test'
import { newBookingFixture } from '../newBookingFixture.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'
import { today, shiftDate, dateLabel } from '../../src/admin/calendarPresentation.js'

let f
const SETTING = 'series_payment_reminder_days'
// The days the tests open for bookings of their own, besides the fixture's day.
const EXTRA_DAYS = [7, 14, 21]
test.beforeEach(async () => { f = await newBookingFixture(37) })
test.afterEach(async () => {
  const series = (await f.admin.from('booking_series').select('id').eq('client_id', f.recipient.id)).data || []
  for (const row of series) await f.admin.from('event_outbox').delete().eq('aggregate_id', row.id)
  await f.admin.from('booking_series').delete().eq('client_id', f.recipient.id)
  await f.admin.from('business_settings').delete().eq('key', SETTING)
  for (const days of EXTRA_DAYS) await f.admin.from('working_hours_overrides').delete().eq('date', shiftDate(f.date, days))
  await f?.cleanup()
})

async function login(page, route) {
  await page.goto(route)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

// New booking, as far as choosing the time: the fixture's client, area, treatment, and the first free time on the fixture's day.
async function startBooking(page) {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page, '/admin/day')
  await expect(page.getByRole('button', { name: '+ New booking', exact: true })).toBeVisible()
  await page.getByLabel('Calendar date', { exact: true }).fill(f.date)
  await page.getByRole('button', { name: '+ New booking', exact: true }).click()
  await page.getByLabel('Find a client').fill(f.recipient.email)
  await page.getByRole('button', { name: new RegExp(f.recipient.first_name) }).click()
  await page.getByRole('combobox', { name: 'Service area', exact: true }).selectOption(f.ids.area)
  await page.getByRole('radio', { name: 'Integration massage', exact: true }).check()
  await page.getByRole('group', { name: 'Available times' }).getByRole('button').first().click()
}

// The first booking and the repeat, made through the Admin's own sign-in exactly as the screen does.
const firstRequest = () => ({
  client_id: f.recipient.id, saved_address_id: f.addresses[0].id, service_area_id: f.ids.area,
  sessions: [{ service_id: f.ids.service, duration_minutes: 60, recipient_name: 'Regular Client', preference_ids: [] }],
  enhancement_ids: [], date: f.date, start_minutes: 600, payment_arrangement: 'bank_pending', note: null,
})
const openDay = date => unwrap(f.admin.from('working_hours_overrides').upsert({ date, available: true, start_minutes: 0, end_minutes: 1440, start_mode: 'flexible' }, { onConflict: 'date' }))
const heldDates = async id => (await unwrap(f.admin.from('calendar_blocks').select('date').eq('series_id', id).order('date'))).map(row => row.date)

test('a booking can be made to repeat weekly, the slot is held, and the repeat is managed from the client', async ({ page }) => {
  await startBooking(page)

  const repeat = page.getByRole('checkbox', { name: 'Repeat this booking' })
  await repeat.check()
  await expect(page.getByText('Only the next appointment is asked to be paid')).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Every week', exact: true })).toBeChecked()
  const end = shiftDate(f.date, 21)
  await page.getByLabel('Stop repeating after (optional)').fill(end)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(page.getByText(/Repeats every .* until/)).toBeVisible()
  await page.getByRole('button', { name: 'Create booking', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText('Part of a repeating booking')

  const series = await unwrap(f.admin.from('booking_series').select('id,status,end_date,first_date,pattern,every_weeks').eq('client_id', f.recipient.id))
  expect(series).toHaveLength(1)
  expect(series[0]).toMatchObject({ status: 'active', end_date: end, first_date: f.date, pattern: 'weeks', every_weeks: 1 })
  expect(await heldDates(series[0].id)).toEqual([shiftDate(f.date, 7), shiftDate(f.date, 14), shiftDate(f.date, 21)])

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
  const upcoming = section.getByRole('group', { name: 'Coming up' })
  await expect(upcoming).toContainText('Kept free for them')
  await section.getByLabel('Skip a date').fill(shiftDate(f.date, 14))
  await section.getByRole('button', { name: 'Skip this date' }).click()
  await expect(upcoming).toContainText('Skipped')
  expect(await heldDates(series[0].id)).not.toContain(shiftDate(f.date, 14))
  await section.getByRole('button', { name: 'Put back' }).click()
  await expect(upcoming).not.toContainText('Skipped')
  await section.getByRole('button', { name: 'Pause' }).click()
  await expect(section).toContainText('Paused')
  expect(await heldDates(series[0].id)).toHaveLength(0)
  await section.getByRole('button', { name: 'Resume' }).click()
  await expect(section).toContainText('Repeating')
  await section.getByRole('button', { name: 'Stop repeating' }).click()
  await section.getByRole('button', { name: 'Yes, stop repeating' }).click()
  await expect(section).toContainText('Ended')
  expect(await heldDates(series[0].id)).toHaveLength(0)
})

test('a booking can be made to repeat every 2 weeks, and only those weeks are held', async ({ page }) => {
  await startBooking(page)
  await page.getByRole('checkbox', { name: 'Repeat this booking' }).check()
  await page.getByRole('radio', { name: 'Every 2 weeks', exact: true }).check()
  await expect(page.getByText(/Every 2 weeks, on \w+, at \d\d:\d\d/)).toBeVisible()
  const end = shiftDate(f.date, 28)
  await page.getByLabel('Stop repeating after (optional)').fill(end)
  await expect(page.getByText(/Repeats every 2 weeks, on \w+ until/)).toBeVisible()
  await page.getByRole('button', { name: 'Create booking', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Part of a repeating booking')

  const series = await unwrap(f.admin.from('booking_series').select('id,end_date,pattern,every_weeks,month_week,custom_dates').eq('client_id', f.recipient.id))
  expect(series).toHaveLength(1)
  expect(series[0]).toMatchObject({ end_date: end, pattern: 'weeks', every_weeks: 2, month_week: null, custom_dates: null })
  expect(await heldDates(series[0].id)).toEqual([shiftDate(f.date, 14), shiftDate(f.date, 28)])

  // The client's page says how it repeats and lists the dates that are coming.
  await page.goto(`/admin/clients/${f.recipient.id}`)
  const section = page.getByRole('region', { name: 'Repeating bookings' })
  await expect(section).toContainText('Every 2 weeks, on')
  const upcoming = section.getByRole('group', { name: 'Coming up' })
  await expect(upcoming.getByRole('listitem')).toHaveCount(3)
  await expect(upcoming).toContainText(dateLabel(shiftDate(f.date, 14), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))
  await expect(upcoming).not.toContainText(dateLabel(shiftDate(f.date, 7), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))
})

test('a booking can be made to repeat monthly on the same weekday', async ({ page }) => {
  await startBooking(page)
  await page.getByRole('checkbox', { name: 'Repeat this booking' }).check()
  await page.getByRole('radio', { name: 'Every month', exact: true }).check()
  await expect(page.getByText(/Every month, on the (first|second|third|fourth|last) \w+, at \d\d:\d\d/)).toBeVisible()
  await expect(page.getByText(/Repeats on the (first|second|third|fourth|last) \w+ of every month, with no end date/)).toBeVisible()
  await page.getByRole('button', { name: 'Create booking', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Part of a repeating booking')

  const series = await unwrap(f.admin.from('booking_series').select('id,weekday,pattern,every_weeks,month_week').eq('client_id', f.recipient.id))
  expect(series).toHaveLength(1)
  expect(series[0]).toMatchObject({ pattern: 'monthly', every_weeks: 1 })
  expect(series[0].month_week).toBe(Math.min(Math.floor((Number(f.date.slice(8, 10)) - 1) / 7) + 1, 5))
  // Held on the same weekday of later months, each in the same week of its month.
  const held = await heldDates(series[0].id)
  expect(held.length).toBeGreaterThanOrEqual(10)
  for (const date of held) expect(new Date(`${date}T12:00:00Z`).getUTCDay()).toBe(new Date(`${f.date}T12:00:00Z`).getUTCDay())
  expect(held[0] > shiftDate(f.date, 27) && held[0] < shiftDate(f.date, 36)).toBe(true)
})

test('the dates of a repeat can be picked on a calendar', async ({ page }) => {
  await startBooking(page)
  await page.getByRole('checkbox', { name: 'Repeat this booking' }).check()
  await page.getByRole('radio', { name: 'Dates I choose', exact: true }).check()
  // Making a repeat of chosen dates needs at least one, and says so in words.
  await page.getByRole('button', { name: 'Create booking', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Choose the dates it repeats on')
  const full = date => dateLabel(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const dates = [shiftDate(f.date, 3), shiftDate(f.date, 12), shiftDate(f.date, 40)]
  // The day of the first appointment, and the days before it, cannot be chosen.
  await expect(page.getByRole('button', { name: `${full(f.date)} (the first appointment)`, exact: true })).toBeDisabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const date of dates) {
    const day = page.getByRole('button', { name: full(date), exact: true })
    for (let step = 0; step < 4 && !(await day.isVisible()); step++) await page.getByRole('button', { name: 'Next month', exact: true }).click()
    await day.click()
    await expect(day).toHaveAttribute('aria-pressed', 'true')
  }
  const chosen = page.getByRole('list', { name: 'Chosen dates' })
  await expect(chosen.getByRole('listitem')).toHaveCount(3)
  // A date can be taken off again, by tapping it in the list.
  await chosen.getByRole('button', { name: `Remove ${full(dates[1])}`, exact: true }).click()
  await expect(chosen.getByRole('listitem')).toHaveCount(2)
  await expect(page.getByText(/Repeats on 2 more dates/)).toBeVisible()
  await page.getByRole('button', { name: 'Create booking', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Part of a repeating booking')

  const series = await unwrap(f.admin.from('booking_series').select('id,end_date,first_date,pattern,custom_dates').eq('client_id', f.recipient.id))
  expect(series).toHaveLength(1)
  expect(series[0]).toMatchObject({ pattern: 'dates', first_date: f.date, end_date: dates[2], custom_dates: [f.date, dates[0], dates[2]] })
  expect(await heldDates(series[0].id)).toEqual([dates[0], dates[2]])
})

test('some dates of a repeat, or everything still to come, can be cancelled from the client, with no late fee', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  for (const days of EXTRA_DAYS) await openDay(shiftDate(f.date, days))
  await unwrap(f.admin.from('business_settings').upsert({ key: SETTING, value: 60 }, { onConflict: 'key' }))
  const made = await unwrap(f.client.rpc('admin_create_series', { p_request: firstRequest(), p_end_date: null, p_request_id: crypto.randomUUID() }))
  // With payment asked for 60 days ahead, the next three weekly sessions become bookings now; the weeks after are only held.
  await unwrap(f.admin.rpc('run_series_maintenance'))
  const seriesId = made[0].series_id
  const sessions = async () => unwrap(f.admin.from('bookings').select('date,booking_status,cancellation_initiated_by,late_fee_status,late_fee_due_gbp,refund_due_gbp').eq('series_id', seriesId).order('date'))
  expect((await sessions()).map(row => row.date)).toEqual([f.date, ...EXTRA_DAYS.map(days => shiftDate(f.date, days))])

  await login(page, `/admin/clients/${f.recipient.id}`)
  const section = page.getByRole('region', { name: 'Repeating bookings' })
  const upcoming = section.getByRole('group', { name: 'Coming up' })
  const label = date => dateLabel(date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  await expect(upcoming).toContainText('Booked · Confirmed')
  await expect(section.getByRole('button', { name: 'Cancel selected dates', exact: true })).toBeDisabled()
  // The first six dates are shown; the rest of the next twelve are a tap away.
  await expect(upcoming.getByRole('listitem')).toHaveCount(6)
  await section.getByRole('button', { name: 'Show the other 6 dates', exact: true }).click()
  await expect(upcoming.getByRole('listitem')).toHaveCount(12)
  // One booked date and one that is only held, together.
  const booked = shiftDate(f.date, 7)
  const held = shiftDate(f.date, 28)
  await upcoming.getByRole('checkbox', { name: new RegExp(label(booked)) }).check()
  await upcoming.getByRole('checkbox', { name: new RegExp(label(held)) }).check()
  await section.getByRole('button', { name: 'Cancel 2 selected dates', exact: true }).click()
  await expect(section.getByRole('alert')).toContainText('1 booking will be cancelled')
  await expect(section.getByRole('alert')).toContainText('No late fee is charged')
  await expect(section.getByRole('alert')).toContainText('only being kept free will be released')
  // Asking first: nothing has been cancelled yet, and "Keep them" leaves it all as it was.
  expect((await sessions()).every(row => row.booking_status !== 'cancelled')).toBe(true)
  await section.getByRole('button', { name: 'Keep them', exact: true }).click()
  await expect(section.getByRole('alert')).toHaveCount(0)
  await section.getByRole('button', { name: 'Cancel 2 selected dates', exact: true }).click()
  await section.getByRole('button', { name: 'Yes, cancel them', exact: true }).click()
  await expect(upcoming).toContainText('Cancelled')
  const afterSome = await sessions()
  expect(afterSome.map(row => row.booking_status)).toEqual(['confirmed', 'cancelled', 'confirmed', 'confirmed'])
  expect(afterSome[1]).toMatchObject({ cancellation_initiated_by: 'admin', late_fee_status: 'none', late_fee_due_gbp: 0 })
  expect(await heldDates(seriesId)).not.toContain(held)
  // The repeat goes on: its other dates are still there.
  await expect(section).toContainText('Repeating')
  expect(await heldDates(seriesId)).toContain(shiftDate(f.date, 35))

  // Everything still to come, and the repeat ends.
  await section.getByRole('button', { name: 'Cancel all upcoming', exact: true }).click()
  await expect(section.getByRole('alert')).toContainText('3 bookings will be cancelled')
  await section.getByRole('button', { name: 'Yes, cancel all upcoming', exact: true }).click()
  await expect(section).toContainText('Ended')
  const afterAll = await sessions()
  expect(afterAll.every(row => row.booking_status === 'cancelled' && row.cancellation_initiated_by === 'admin' && row.late_fee_status === 'none')).toBe(true)
  expect(await heldDates(seriesId)).toHaveLength(0)
  expect((await unwrap(f.admin.from('booking_series').select('status').eq('id', seriesId).single())).status).toBe('ended')
  // The client is told about each booking that was cancelled.
  const messages = await unwrap(f.admin.from('notification_deliveries').select('title').eq('recipient', f.recipient.email))
  expect(messages.filter(row => row.title === 'Your appointment has been cancelled')).toHaveLength(4)
})

test('the daily job books the next session and asks the client to pay for it', async () => {
  await openDay(shiftDate(f.date, 7))
  // Make the first booking and the repeat through the Admin's own sign-in, exactly as the screen does.
  const made = await unwrap(f.client.rpc('admin_create_series', { p_request: firstRequest(), p_end_date: null, p_request_id: crypto.randomUUID() }))
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
