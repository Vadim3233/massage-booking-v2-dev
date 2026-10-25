import { test, expect } from '@playwright/test'
import { newBookingFixture } from '../newBookingFixture.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'
import { shiftDate } from '../../src/admin/calendarPresentation.js'

// Her day (a Sunday can be set like this): working 09:00 to 21:00, the first appointment at a set time, 12:00, and one booking, at 12:00.
// Moving that booking sets it aside, so the day looks empty and the usual list is 12:00 and nothing else. The client asked for 17:30.
let f, id, nextDay, nextDayBefore
test.beforeEach(async () => {
  f = await newBookingFixture(38)
  await unwrap(f.admin.from('working_hours_overrides').upsert({ date: f.date, available: true, start_minutes: 540, end_minutes: 1260, start_mode: 'fixed', fixed_start_minutes: 720 }))
  id = (await book(720))[0].booking_id
  nextDay = shiftDate(f.date, 1)
  nextDayBefore = await unwrap(f.admin.from('working_hours_overrides').select('date,available,start_minutes,end_minutes,start_mode,fixed_start_minutes,note').eq('date', nextDay))
})
test.afterEach(async () => {
  if (nextDayBefore?.length) await unwrap(f.admin.from('working_hours_overrides').upsert(nextDayBefore))
  else if (nextDay) await unwrap(f.admin.from('working_hours_overrides').delete().eq('date', nextDay))
  await f?.cleanup()
})

// An appointment made the way the Admin's own screen makes it, for the day above.
const request = (start, anyTime) => ({
  client_id: f.recipient.id, saved_address_id: f.addresses[0].id, service_area_id: f.ids.area,
  sessions: [{ service_id: f.ids.service, duration_minutes: 60, recipient_name: 'Someone', preference_ids: [] }],
  enhancement_ids: [], date: f.date, start_minutes: start, payment_arrangement: 'bank_pending', note: null, ...(anyTime ? { any_time: true } : {}),
})
const book = (start, anyTime) => unwrap(f.client.rpc('admin_create_booking', { p_request_id: crypto.randomUUID(), p_request: request(start, anyTime) }))

const details = page => page.locator('dialog.admin-details')
const action = page => page.locator('dialog.admin-action')
const allTimes = page => action(page).locator('.anb-alltimes')
const chip = (page, label) => allTimes(page).getByRole('button', { name: new RegExp(`^${label}( |$)`) })
const usualTimes = page => action(page).getByRole('group', { name: 'Available times' }).getByRole('button')
const note = page => action(page).locator('.anb-time-note')
const row = () => unwrap(f.admin.from('bookings').select('date,start_minutes,booking_status').eq('id', id).single())

async function reschedule(page) {
  await page.goto(`/admin/bookings/${id}`)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(details(page)).toBeVisible()
  await details(page).getByRole('button', { name: 'Reschedule', exact: true }).click()
  await expect(action(page)).toBeVisible()
}
const showAll = async page => {
  await allTimes(page).getByRole('button', { name: 'Show all times', exact: true }).click()
  await expect(chip(page, '06:00')).toBeVisible()
}
const confirm = page => action(page).getByRole('button', { name: 'Reschedule', exact: true })

test('the only booking of a day that starts at a set time can be moved to 17:30 with Show all times', async ({ page }) => {
  await reschedule(page)
  // What was reported: set aside to be moved, the day looks empty, so the usual list is the day's one set time.
  await expect(usualTimes(page)).toHaveText(['12:00'])
  await expect(allTimes(page).getByText('Want a time that is not listed')).toBeVisible()
  await showAll(page)
  await expect(allTimes(page).getByRole('button', { name: 'Hide all times', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await expect(allTimes(page)).toContainText('Your working hours: 09:00–21:00.')
  // The booking is not in its own way: its own time is free, and so is 17:30, which is not a usual time.
  await expect(allTimes(page)).toContainText('Nothing is booked yet.')
  await expect(chip(page, '12:00')).toHaveAttribute('data-usual', 'yes')
  await expect(chip(page, '12:00')).not.toHaveAttribute('aria-disabled', 'true')
  await expect(chip(page, '17:30')).toHaveAttribute('data-usual', 'no')
  await expect(chip(page, '17:30')).not.toHaveAttribute('aria-disabled', 'true')
  // The look comes with the button even though New booking was never opened in this visit: times that are not usual are dashed.
  await expect(chip(page, '17:30')).toHaveCSS('border-top-style', 'dashed')
  await expect(chip(page, '12:00')).not.toHaveCSS('border-top-style', 'dashed')
  await chip(page, '17:30').click()
  await expect(chip(page, '17:30')).toHaveAttribute('aria-pressed', 'true')
  // What is being set aside is said once, under the times where she tapped; beside the button that confirms it is only a reminder.
  await expect(action(page).locator('.admin-new-time')).toHaveText(/17:30 · outside your usual times$/)
  await expect(note(page)).toHaveCount(1)
  await expect(note(page)).toContainText('Outside your usual times')
  await expect(note(page)).toContainText('Not your usual start time for this day.')
  expect(await action(page).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/admin-reschedule-all-times-390.png' })
  const asked = page.waitForRequest(request => request.url().includes('/rpc/admin_reschedule_booking'))
  await confirm(page).click()
  expect((await asked).postDataJSON()).toMatchObject({ p_new_start_minutes: 1050, p_any_time: true, p_initiated_by: 'client' })
  await expect(details(page).getByText('Booking moved.')).toBeVisible()
  expect(await row()).toEqual({ date: f.date, start_minutes: 1050, booking_status: 'confirmed' })
  await details(page).getByText('History', { exact: true }).click()
  await expect(details(page)).toContainText('Moved from')
})

test('a usual time is moved to exactly as before, with no "any time" in the request', async ({ page }) => {
  await unwrap(f.admin.from('working_hours_overrides').upsert({ date: nextDay, available: true, start_minutes: 600, end_minutes: 1260, start_mode: 'flexible', fixed_start_minutes: null }))
  await reschedule(page)
  await page.getByLabel('New date').fill(nextDay)
  await expect(usualTimes(page).first()).toBeVisible()
  await usualTimes(page).first().click()
  await expect(note(page)).toHaveCount(0)
  const asked = page.waitForRequest(request => request.url().includes('/rpc/admin_reschedule_booking'))
  await confirm(page).click()
  const body = (await asked).postDataJSON()
  expect(body).toMatchObject({ p_new_date: nextDay, p_new_start_minutes: 600 })
  expect(body).not.toHaveProperty('p_any_time')
  await expect(details(page).getByText('Booking moved.')).toBeVisible()
  expect(await row()).toEqual({ date: nextDay, start_minutes: 600, booking_status: 'confirmed' })
})

test('picking a usual time again takes the note away, and a usual time from the full list counts as usual', async ({ page }) => {
  await reschedule(page)
  await showAll(page)
  await chip(page, '17:30').click()
  await expect(note(page)).toHaveCount(1)
  await expect(action(page).locator('.admin-new-time')).toContainText('outside your usual times')
  await usualTimes(page).first().click()
  await expect(note(page)).toHaveCount(0)
  await expect(action(page).locator('.admin-new-time')).toHaveText(/12:00$/)
  await chip(page, '17:30').click()
  await chip(page, '12:00').click()
  await expect(note(page)).toHaveCount(0)
  await expect(action(page).locator('.admin-new-time')).toHaveText(/12:00$/)
})

test('a time that overlaps another appointment cannot be chosen, and says what it clashes with', async ({ page }) => {
  await book(1050, true)
  await reschedule(page)
  await showAll(page)
  await expect(allTimes(page)).toContainText('Already booked: 17:30–18:30')
  // The booking being moved is not counted as in its own way.
  await expect(chip(page, '12:00')).not.toHaveAttribute('aria-disabled', 'true')
  await expect(chip(page, '18:00')).toHaveAttribute('aria-disabled', 'true')
  await chip(page, '18:00').click({ force: true })
  await expect(allTimes(page).locator('.anb-time-note')).toHaveText(/^Clashes with the 17:30–18:30 appointment for /)
  await expect(chip(page, '18:00')).toHaveAttribute('aria-pressed', 'false')
  await expect(confirm(page)).toBeDisabled()
  await chip(page, '19:30').click()
  await expect(confirm(page)).toBeEnabled()
})

test('a client who starts booking while the time is being chosen: the move is refused in plain words, nothing moves, and the times are asked for again', async ({ page }) => {
  await reschedule(page)
  await showAll(page)
  await chip(page, '17:30').click()
  // A client begins booking that day (14:00 is what the booking page offers once 12:00 is taken). A hold lasts a few minutes.
  const key = f.key()
  const hold = await f.publicApi.hold(f.date, 840, 60, key)
  await confirm(page).click()
  await expect(action(page).getByRole('alert')).toHaveText('A client is in the middle of booking that day. Try again in a few minutes.')
  await expect(action(page)).toBeVisible()
  expect(await row()).toEqual({ date: f.date, start_minutes: 720, booking_status: 'confirmed' })
  // The times shown are asked for again, so they now say the unusual ones are paused.
  await expect(allTimes(page)).toContainText('A client is in the middle of booking this day, so times outside the usual ones are paused for a few minutes.')
  await expect(chip(page, '19:00')).toHaveAttribute('aria-disabled', 'true')
  // Once the client has finished or left, the move goes through.
  await f.publicApi.release(hold, key)
  await allTimes(page).getByRole('button', { name: 'Hide all times', exact: true }).click()
  await allTimes(page).getByRole('button', { name: 'Show all times', exact: true }).click()
  await expect(chip(page, '17:30')).not.toHaveAttribute('aria-disabled', 'true')
  await chip(page, '17:30').click()
  await confirm(page).click()
  await expect(details(page).getByText('Booking moved.')).toBeVisible()
  expect((await row()).start_minutes).toBe(1050)
})

for (const width of [320, 390]) {
  test(`all the times fit a ${width}px phone in the Reschedule sheet, with the note`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await reschedule(page)
    await showAll(page)
    await chip(page, '17:30').click()
    const fits = await page.evaluate(limit => {
      const sheet = document.querySelector('dialog.admin-action')
      const inside = [...sheet.querySelectorAll('button, .anb-time-note, p')].every(item => { const r = item.getBoundingClientRect(); return r.width === 0 || (r.left >= -0.5 && r.right <= limit + 0.5) })
      return inside && sheet.scrollWidth <= sheet.clientWidth && document.documentElement.scrollWidth <= document.documentElement.clientWidth
    }, width)
    expect(fits).toBe(true)
  })
}
