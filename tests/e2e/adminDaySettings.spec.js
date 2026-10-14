import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'
import { dateLabel, shiftDate, today } from '../../src/admin/calendarPresentation.js'

// The fixture's own day (today plus 5) has two bookings, a confirmed one at 10:00 and a cancelled one at 13:00, and its own hours, 10:00 to 22:00.
let f
const undo = []
test.beforeEach(async () => { f = await adminFixture(5) })
test.afterEach(async () => {
  for (const step of undo.splice(0).reverse()) await step()
  await f.admin.from('calendar_blocks').delete().eq('title', 'Dentist')
  await f?.cleanup()
})

async function login(page, path = '/admin/agenda') {
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
const long = date => dateLabel(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const dayButton = (page, date) => page.getByRole('button', { name: `Day settings for ${long(date)}` })
const override = async date => (await f.admin.from('working_hours_overrides').select('*').eq('date', date).maybeSingle()).data
const save = page => page.getByRole('button', { name: /^Save (this day|anyway)$/ })

test('a day opens from the Agenda, says what it is set to and why, and Back returns to the Agenda', async ({ page }) => {
  await f.authorize()
  await login(page)
  await dayButton(page, f.date).click()
  await expect(page).toHaveURL(new RegExp(`/admin/day-settings\\?date=${f.date}$`))
  await expect(page.getByRole('heading', { name: 'Day settings', level: 1 })).toBeFocused()
  await expect(page.getByText(long(f.date), { exact: true })).toBeVisible()
  const glance = page.getByRole('region', { name: 'This day at a glance' })
  await expect(glance).toContainText('Working 10:00–22:00 · Chain · First appointment: any time')
  // The cancelled booking is not part of the day's run.
  await expect(glance).toContainText('1 booking · 10:00–11:00')
  await expect(glance).toContainText('A special day')
  await expect(page.getByRole('navigation', { name: 'Admin navigation' }).getByRole('link', { name: 'Calendar', exact: true })).toHaveAttribute('aria-current', 'page')
  // Nothing has been changed, so there is nothing to save.
  await expect(save(page)).toBeDisabled()
  await expect(page.getByText('You have changes that are not saved yet.')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('link', { name: '← Agenda' }).click()
  await expect(page).toHaveURL(/\/admin\/agenda$/)
  await expect(page.getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible()
})

test('a day opens from the Day view too, and Back returns to that day', async ({ page }) => {
  await f.authorize()
  await login(page, `/admin?date=${f.date}`)
  await page.getByRole('button', { name: 'Day settings', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/day-settings\\?date=${f.date}$`))
  await expect(page.getByText(long(f.date), { exact: true })).toBeVisible()
  await page.getByRole('link', { name: '← Day' }).click()
  await expect(page).toHaveURL(new RegExp(`/admin\\?date=${f.date}$`))
  await expect(page.getByLabel('Calendar date', { exact: true })).toHaveValue(f.date)
})

test('the hours, schedule mode, first appointment and release time are saved together with one button, and the summary follows', async ({ page }) => {
  await f.authorize()
  await login(page)
  await dayButton(page, f.date).click()
  await page.getByLabel('This day schedule mode').selectOption('flexible')
  await expect(page.getByText('You have changes that are not saved yet.')).toBeVisible()
  await page.getByLabel('This day first appointment').first().selectOption('fixed')
  await page.getByLabel('This day first appointment time').selectOption('900')
  await page.getByLabel('This day release time').selectOption('1020')
  await page.getByLabel('Note (only you see this)').fill('Late start')
  await save(page).click()
  await expect(page.getByText('Saved. This day now has its own settings.')).toBeVisible()
  const glance = page.getByRole('region', { name: 'This day at a glance' })
  await expect(glance).toContainText('Working 10:00–22:00 · Flexible · First appointment 15:00, released 17:00 the day before')
  await expect(glance).toContainText('A special day: Late start')
  await expect(save(page)).toBeDisabled()
  expect(await override(f.date)).toMatchObject({ available: true, start_minutes: 600, end_minutes: 1320, schedule_mode: 'flexible', start_mode: 'fixed', fixed_start_minutes: 900, anchor_release_minutes: 1020, note: 'Late start' })
  // The Agenda, and the Special days list, show the same day.
  await page.getByRole('link', { name: '← Agenda' }).click()
  await expect(page.locator('.admin-agenda-notes').first()).toContainText('Late start')
  await page.goto('/admin/schedule')
  await page.getByRole('tab', { name: 'Special days' }).click()
  await expect(page.locator('.admin-special-list li', { hasText: 'Late start' })).toContainText('first appointment at 15:00 (released at 17:00 the day before), flexible schedule')
})

test('different hours that leave a booking outside them are warned about once, and never move the booking; a different mode alone is not', async ({ page }) => {
  await f.authorize()
  await login(page)
  await dayButton(page, f.date).click()
  await page.getByLabel('This day start').selectOption('660')
  await save(page).click()
  await expect(page.getByRole('alert').filter({ hasText: 'This clashes with a booking' })).toBeVisible()
  expect((await override(f.date)).start_minutes).toBe(600)
  await page.getByRole('button', { name: 'Save anyway' }).click()
  await expect(page.getByText('Saved. This day now has its own settings.')).toBeVisible()
  expect((await override(f.date)).start_minutes).toBe(660)
  expect((await f.admin.from('bookings').select('booking_status,start_minutes').eq('id', f.bookings[0].id).single()).data).toEqual({ booking_status: 'confirmed', start_minutes: 600 })
  // The hours are as saved now, so changing only how the day fills up is not a reason to warn again.
  await page.getByLabel('This day schedule mode').selectOption('flexible')
  await save(page).click()
  await expect(page.getByText('Saved. This day now has its own settings.')).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'This clashes' })).toHaveCount(0)
  expect(await override(f.date)).toMatchObject({ start_minutes: 660, schedule_mode: 'flexible' })
})

test('a day can be switched off, switched on again from its usual hours, and put back to the usual week', async ({ page }) => {
  await f.authorize()
  const date = shiftDate(f.date, 21)
  undo.push(() => f.admin.from('working_hours_overrides').delete().eq('date', date))
  await login(page, `/admin/day-settings?date=${date}`)
  const weekday = dateLabel(date, { weekday: 'long' })
  await expect(page.getByRole('region', { name: 'This day at a glance' })).toContainText(`Follows your usual ${weekday}`)
  await expect(page.getByRole('button', { name: 'Use my usual week' })).toHaveCount(0)
  const working = page.getByRole('checkbox', { name: 'Working day' })
  const usuallyWorking = await working.isChecked()
  // Whatever the weekday usually is, make the day the other way round.
  if (usuallyWorking) await working.uncheck(); else await working.check()
  await save(page).click()
  await expect(page.getByText('Saved. This day now has its own settings.')).toBeVisible()
  expect((await override(date)).available).toBe(!usuallyWorking)
  await expect(page.getByRole('region', { name: 'This day at a glance' })).toContainText(usuallyWorking ? 'Not a working day' : 'Working 10:00–20:00 · Chain')
  await page.getByRole('button', { name: 'Use my usual week' }).click()
  await expect(page.getByText(`Removed. This day follows your usual ${weekday} again.`)).toBeVisible()
  expect(await override(date)).toBeNull()
  await expect(page.getByRole('region', { name: 'This day at a glance' })).toContainText(`Follows your usual ${weekday}`)
  await expect(page.getByRole('button', { name: 'Use my usual week' })).toHaveCount(0)
})

test('a mistake in the hours is said in words beside the fields, and nothing is saved until it is put right', async ({ page }) => {
  await f.authorize()
  await login(page)
  await dayButton(page, f.date).click()
  await page.getByLabel('This day end').selectOption('600')
  await expect(page.getByRole('alert').filter({ hasText: 'The end time must be after the start time.' })).toBeVisible()
  await expect(save(page)).toBeDisabled()
  await page.getByLabel('This day end').selectOption('1260')
  await expect(page.getByRole('alert').filter({ hasText: 'The end time must be after' })).toHaveCount(0)
  await expect(save(page)).toBeEnabled()
})

test('time blocked on the day is listed, can be added from here, and can be changed or removed', async ({ page }) => {
  await f.authorize()
  await login(page)
  await dayButton(page, f.date).click()
  await expect(page.getByText('Nothing is blocked on this day.')).toBeVisible()
  await page.getByRole('button', { name: 'Block time', exact: true }).click()
  const dialog = page.locator('dialog.admin-action')
  await dialog.getByLabel('A personal event').check()
  await dialog.getByLabel('Name of the event').fill('Dentist')
  await dialog.getByRole('button', { name: 'Block this time' }).click()
  const row = page.locator('.admin-day-settings-section li', { hasText: 'Dentist' })
  await expect(row).toContainText('12:00–13:00')
  await row.getByRole('button', { name: /^Change Dentist/ }).click()
  await expect(dialog.getByRole('heading', { name: 'Change blocked time' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
  await dialog.getByRole('button', { name: 'Yes, remove' }).click()
  await expect(page.getByText('Nothing is blocked on this day.')).toBeVisible()
  expect((await f.admin.from('calendar_blocks').select('id').eq('title', 'Dentist')).data).toHaveLength(0)
})

test("the day's bookings are listed, open from here, and closing one comes back to the day", async ({ page }) => {
  await f.authorize()
  await login(page)
  await dayButton(page, f.date).click()
  await expect(page.getByRole('list', { name: `Bookings for ${long(f.date)}` }).locator('.admin-card')).toHaveCount(2)
  await page.locator('.admin-card').first().click()
  await expect(page.getByRole('dialog')).toContainText(f.bookings[0].booking_reference)
  await page.getByRole('button', { name: 'Close details' }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/day-settings\\?date=${f.date}$`))
  await expect(page.getByRole('heading', { name: 'Day settings', level: 1 })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('a day that has passed can be looked at but not changed', async ({ page }) => {
  await f.authorize()
  const yesterday = shiftDate(today(), -1)
  await login(page, `/admin/day-settings?date=${yesterday}`)
  await expect(page.getByRole('heading', { name: 'Day settings', level: 1 })).toBeVisible()
  await expect(page.getByText('This day has passed, so its settings cannot be changed.')).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Working day' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Save this day' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Block time', exact: true })).toHaveCount(0)
})

test('an address that is not a date says so instead of showing a blank page', async ({ page }) => {
  await f.authorize()
  await login(page, '/admin/day-settings?date=2031-02-30')
  await expect(page.getByRole('alert')).toContainText('That is not a date.')
})

test('with Show every day on, the date of a free day opens that day', async ({ page }) => {
  await f.authorize()
  await login(page)
  await page.getByRole('switch', { name: 'Show every day' }).check()
  const free = shiftDate(today(), 1)
  await page.getByRole('button', { name: `Day settings for ${long(free)}` }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/day-settings\\?date=${free}$`))
  await expect(page.getByText(long(free), { exact: true })).toBeVisible()
  await expect(page.getByText('No bookings on this day.')).toBeVisible()
})

test('the screen fits a small phone', async ({ page }) => {
  await f.authorize()
  await page.setViewportSize({ width: 320, height: 640 })
  await login(page)
  await dayButton(page, f.date).click()
  await page.getByLabel('This day first appointment').first().selectOption('fixed')
  await expect(page.getByLabel('This day release time')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/admin-day-settings-320.png', fullPage: true })
})
