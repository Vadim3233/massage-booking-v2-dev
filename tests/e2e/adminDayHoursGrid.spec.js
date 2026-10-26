import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'
import { dateLabel } from '../../src/admin/calendarPresentation.js'

// The fixture's own day (today plus 5) is open 10:00 to 22:00 and has a confirmed booking at 10:00 for an hour, with an hour's travel either side.
let f
test.beforeEach(async () => { f = await adminFixture(5) })
test.afterEach(async () => {
  await f.admin.from('calendar_blocks').delete().eq('date', f.date)
  await f?.cleanup()
})

async function openGrid(page) {
  await f.authorize()
  await page.goto(`/admin?date=${f.date}`)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Edit hours', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/day-hours\\?date=${f.date}$`))
  await expect(page.getByRole('heading', { name: 'Edit hours', level: 1 })).toBeFocused()
}
const cell = (page, time) => page.getByRole('button', { name: new RegExp(`^${time} to `) })
const blocks = async () => (await f.admin.from('calendar_blocks').select('start_minutes,end_minutes,kind,title').eq('date', f.date).order('start_minutes')).data
const override = async () => (await f.admin.from('working_hours_overrides').select('available,start_minutes,end_minutes').eq('date', f.date).single()).data

test('the day opens from the Day view as half hours: working ones pressed, the booking and its travel locked', async ({ page }) => {
  await openGrid(page)
  await expect(page.getByText('10:00–22:00', { exact: true })).toBeVisible()
  await expect(cell(page, '12:00')).toHaveAttribute('aria-pressed', 'true')
  await expect(cell(page, '22:00')).toHaveAttribute('aria-pressed', 'false')
  await expect(cell(page, '10:00')).toHaveAccessibleName(/booking/)
  await expect(cell(page, '11:00')).toHaveAccessibleName(/travel time/)
  // Nothing has been tapped, so there is nothing to save.
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  // A booking cannot be tapped closed; the screen says why.
  await cell(page, '10:00').click()
  await expect(page.getByText('This half hour has a booking. Move or cancel the booking first.')).toBeVisible()
  await expect(cell(page, '10:00')).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('tapping two half hours closed saves them as blocked time and goes back to the day', async ({ page }) => {
  await openGrid(page)
  await cell(page, '13:00').click()
  await cell(page, '13:30').click()
  await expect(cell(page, '13:00')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByText('10:00–13:00, 14:00–22:00', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Save 2 changes', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/admin\\?date=${f.date}$`))
  await expect(page.getByText(`Saved · ${dateLabel(f.date)}`).last()).toBeVisible()
  expect(await blocks()).toEqual([{ start_minutes: 780, end_minutes: 840, kind: 'blocked', title: null }])
  expect(await override()).toEqual({ available: true, start_minutes: 600, end_minutes: 1320 })
})

test('sliding down several half hours closes them together, and the end of the day moves the hours', async ({ page }) => {
  await openGrid(page)
  await cell(page, '20:00').evaluate(element => element.scrollIntoView({ block: 'center' }))
  const first = await cell(page, '20:00').boundingBox()
  const last = await cell(page, '21:30').boundingBox()
  await page.mouse.move(first.x + 40, first.y + first.height / 2)
  await page.mouse.down()
  await page.mouse.move(last.x + 40, last.y + last.height / 2, { steps: 8 })
  await page.mouse.up()
  for (const time of ['20:00', '20:30', '21:00', '21:30']) await expect(cell(page, time)).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: 'Save 4 changes', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/admin\\?date=${f.date}$`))
  expect(await override()).toEqual({ available: true, start_minutes: 600, end_minutes: 1200 })
  expect(await blocks()).toEqual([])
})

test('a tap can be undone by tapping again, and Cancel asks before throwing changes away', async ({ page }) => {
  await openGrid(page)
  await cell(page, '15:00').click()
  await cell(page, '15:00').click()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await cell(page, '15:00').click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByText('Discard your change? This day stays as it was.')).toBeVisible()
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(cell(page, '15:00')).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/admin\\?date=${f.date}$`))
  expect(await blocks()).toEqual([])
})

test('Day off closes everything but the booking and its travel', async ({ page }) => {
  await openGrid(page)
  await page.getByRole('switch', { name: 'Day off' }).click()
  await expect(page.getByRole('switch', { name: 'Day off' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText('Your bookings stay as they are.')).toBeVisible()
  await expect(page.getByText('10:00–12:00', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^Save \d+ changes$/ }).click()
  await expect(page).toHaveURL(new RegExp(`/admin\\?date=${f.date}$`))
  expect(await override()).toEqual({ available: true, start_minutes: 600, end_minutes: 720 })
})

test('closing time a client is in the middle of booking is asked about first', async ({ page }) => {
  const client = (await f.admin.from('clients').select('id').limit(1).single()).data
  await f.admin.from('booking_holds').insert({ client_id: client.id, date: f.date, start_minutes: 960, treatment_duration_minutes: 60, travel_buffer_minutes: 60,
    expires_at: new Date(Date.now() + 10 * 60000).toISOString() })
  try {
    await openGrid(page)
    await expect(cell(page, '16:00')).toHaveAccessibleName(/a client is booking this time/)
    await cell(page, '16:00').click()
    await page.getByRole('button', { name: 'Save 1 change', exact: true }).click()
    await expect(page.getByText('A client is booking 16:00–16:30 right now.')).toBeVisible()
    expect(await blocks()).toEqual([])
    await page.getByRole('button', { name: 'Close it anyway', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/admin\\?date=${f.date}$`))
    expect(await blocks()).toEqual([{ start_minutes: 960, end_minutes: 990, kind: 'blocked', title: null }])
  } finally {
    await f.admin.from('booking_holds').delete().eq('date', f.date).eq('start_minutes', 960)
  }
})
