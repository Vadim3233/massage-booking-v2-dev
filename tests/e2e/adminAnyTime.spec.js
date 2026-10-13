import { test, expect } from '@playwright/test'
import { newBookingFixture } from '../newBookingFixture.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'

// Her day: working 14:30 to 17:30, with one appointment already booked 14:30 to 15:30. The booking page offers only 16:30 (an hour's gap after it).
let f
test.beforeEach(async () => {
  f = await newBookingFixture(38)
  await unwrap(f.admin.from('working_hours_overrides').upsert({ date: f.date, available: true, start_minutes: 870, end_minutes: 1050, start_mode: 'flexible', fixed_start_minutes: null }))
  await book(870, false)
})
test.afterEach(async () => { await f?.cleanup() })

// An appointment made the way the Admin's own screen makes it, for the day above.
const request = (start, anyTime, minutes = 60) => ({
  client_id: f.recipient.id, saved_address_id: f.addresses[0].id, service_area_id: f.ids.area,
  sessions: [{ service_id: f.ids.service, duration_minutes: minutes, recipient_name: 'Someone', preference_ids: [] }],
  enhancement_ids: [], date: f.date, start_minutes: start, payment_arrangement: 'bank_pending', note: null, ...(anyTime ? { any_time: true } : {}),
})
const book = (start, anyTime) => unwrap(f.client.rpc('admin_create_booking', { p_request_id: crypto.randomUUID(), p_request: request(start, anyTime) }))

async function newBooking(page) {
  await page.goto('/admin/day')
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: '+ New booking', exact: true })).toBeVisible()
  await page.getByLabel('Calendar date', { exact: true }).fill(f.date)
  await page.getByRole('button', { name: '+ New booking', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'New booking', exact: true })).toBeVisible()
  await page.getByLabel('Find a client').fill(f.recipient.email)
  await page.getByRole('button', { name: new RegExp(f.recipient.first_name) }).click()
  await expect(page.getByRole('radio', { name: /10 Saved Street/ })).toBeChecked()
  await page.getByRole('combobox', { name: 'Service area', exact: true }).selectOption(f.ids.area)
  await page.getByRole('radio', { name: 'Integration massage', exact: true }).check()
  await expect(page.getByLabel('Appointment date')).toHaveValue(f.date)
}
const allTimes = page => page.locator('.anb-alltimes')
const chip = (page, label) => allTimes(page).getByRole('button', { name: new RegExp(`^${label}( |$)`) })
const usualTimes = page => page.getByRole('group', { name: 'Available times' }).getByRole('button')
const note = page => allTimes(page).locator('.anb-time-note')
const showAll = async page => { await allTimes(page).getByRole('button', { name: 'Show all times', exact: true }).click(); await expect(chip(page, '16:00')).toBeVisible() }
const rowsOf = () => unwrap(f.admin.from('bookings').select('start_minutes,booking_status,travel_buffer_minutes').eq('client_id', f.recipient.id).order('start_minutes'))

test('the usual list is unchanged, and Show all times opens every half hour of the day', async ({ page }) => {
  await newBooking(page)
  await expect(usualTimes(page)).toHaveText(['16:30'])
  await expect(allTimes(page).getByText('Want a time that is not listed')).toBeVisible()
  await showAll(page)
  await expect(allTimes(page).getByRole('button', { name: 'Hide all times', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await expect(allTimes(page)).toContainText('Your working hours: 14:30–17:30.')
  await expect(allTimes(page)).toContainText('Already booked: 14:30–15:30')
  await expect(chip(page, '06:00')).toBeVisible()
  await expect(chip(page, '23:00')).toBeVisible()
  await expect(chip(page, '05:30')).toHaveCount(0)
  // The usual time looks as it does above; the others are dashed; times that overlap the appointment are greyed.
  await expect(chip(page, '16:30')).toHaveAttribute('data-usual', 'yes')
  await expect(chip(page, '16:00')).toHaveAttribute('data-usual', 'no')
  await expect(chip(page, '15:00')).toHaveAttribute('aria-disabled', 'true')
  await expect(chip(page, '15:30')).not.toHaveAttribute('aria-disabled', 'true')
  await expect(allTimes(page).getByRole('button', { name: '16:00 not a usual time', exact: true })).toBeVisible()
  await expect(allTimes(page).getByRole('button', { name: '15:00 overlaps another appointment', exact: true })).toBeVisible()
  await expect(allTimes(page).getByRole('button', { name: '16:30', exact: true })).toBeVisible()
  await allTimes(page).getByRole('button', { name: 'Hide all times', exact: true }).click()
  await expect(chip(page, '16:00')).toBeHidden()
})

test('a shorter gap can be chosen on purpose: 16:00, with what is being set aside said plainly', async ({ page }) => {
  await newBooking(page)
  await showAll(page)
  await chip(page, '16:00').click()
  await expect(chip(page, '16:00')).toHaveAttribute('aria-pressed', 'true')
  await expect(note(page).getByText('Outside your usual times')).toBeVisible()
  await expect(note(page).getByText('Only 30 minutes after the 14:30 appointment ends (your usual gap is 60 minutes).')).toBeVisible()
  // The same is said again beside the price, so it is in sight when the booking is made.
  await expect(page.locator('.anb-summary')).toContainText('16:00–17:00')
  await expect(page.locator('.anb-summary')).toContainText('Only 30 minutes after the 14:30 appointment ends')
  // A repeating booking is only offered at usual times.
  await expect(page.getByText('A repeating booking needs one of the usual times.')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Repeat' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Create booking', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(await rowsOf()).toEqual([
    { start_minutes: 870, booking_status: 'confirmed', travel_buffer_minutes: 60 },
    { start_minutes: 960, booking_status: 'confirmed', travel_buffer_minutes: 60 },
  ])
})

test('a longer day can be chosen too: an evening time outside working hours', async ({ page }) => {
  await newBooking(page)
  await showAll(page)
  await chip(page, '19:00').click()
  await expect(note(page).getByText('Outside your working hours (14:30–17:30).')).toBeVisible()
  await page.getByRole('button', { name: 'Create booking', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect((await rowsOf()).map(row => row.start_minutes)).toEqual([870, 1140])
})

test('a time that overlaps another appointment cannot be chosen, and says what it clashes with', async ({ page }) => {
  await newBooking(page)
  await showAll(page)
  await chip(page, '15:00').click({ force: true })
  await expect(note(page)).toHaveText(/^Clashes with the 14:30–15:30 appointment for /)
  await expect(chip(page, '15:00')).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: 'Create booking', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Choose an available appointment time.')
  expect(await rowsOf()).toHaveLength(1)
})

test('a note about a time that cannot be chosen goes away when another time is chosen', async ({ page }) => {
  await newBooking(page)
  await showAll(page)
  await chip(page, '15:00').click({ force: true })
  await expect(note(page)).toHaveText(/^Clashes with/)
  await usualTimes(page).first().click()
  await expect(note(page)).toHaveCount(0)
  await chip(page, '15:00').click({ force: true })
  await expect(note(page)).toHaveText(/^Clashes with/)
  await chip(page, '16:00').click()
  await expect(note(page)).toHaveCount(1)
  await expect(note(page)).toHaveText(/^Outside your usual times/)
})

test('picking a usual time again takes the note away and brings the repeat back', async ({ page }) => {
  await newBooking(page)
  await showAll(page)
  await chip(page, '16:00').click()
  await expect(page.locator('.anb-summary').getByText('Outside your usual times')).toBeVisible()
  await usualTimes(page).first().click()
  await expect(page.locator('.anb-summary')).not.toContainText('Outside your usual times')
  await expect(note(page)).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Repeat' })).toBeVisible()
  // A usual time chosen from the full list counts as usual, and keeps the repeat.
  await chip(page, '16:00').click()
  await chip(page, '16:30').click()
  await expect(page.locator('.anb-summary')).not.toContainText('Outside your usual times')
  await expect(page.getByRole('group', { name: 'Repeat' })).toBeVisible()
})

test('changing the length of the treatment asks for the time again', async ({ page }) => {
  await newBooking(page)
  await showAll(page)
  await chip(page, '16:00').click()
  await expect(page.locator('.anb-summary')).toContainText('16:00–17:00')
  await page.getByRole('radio', { name: /^90 min/ }).check()
  await expect(page.locator('.anb-summary')).toContainText('Choose a time above')
  await expect(page.locator('.anb-summary')).not.toContainText('Outside your usual times')
})

test('if someone else takes the time first, the booking is refused with a plain sentence and nothing is made', async ({ page }) => {
  await newBooking(page)
  await showAll(page)
  await chip(page, '16:00').click()
  await book(960, true)
  await page.getByRole('button', { name: 'Create booking', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('That time overlaps another appointment, so it is not available. Choose another time.')
  await expect(chip(page, '16:00')).toHaveAttribute('aria-disabled', 'true')
  expect((await rowsOf()).map(row => row.start_minutes)).toEqual([870, 960])
})

test('while a client is part-way through booking that day, unusual times are paused and say why', async ({ page }) => {
  const key = f.key()
  const hold = await f.publicApi.hold(f.date, 990, 60, key)
  await newBooking(page)
  await expect(page.getByText('No available times. Choose another date.')).toBeVisible()
  await allTimes(page).getByRole('button', { name: 'Show all times', exact: true }).click()
  await expect(allTimes(page).getByText('A client is in the middle of booking this day, so times outside the usual ones are paused for a few minutes.')).toBeVisible()
  await expect(allTimes(page).getByRole('button', { name: '19:00 paused while a client is booking', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await chip(page, '19:00').click({ force: true })
  await expect(note(page).last()).toHaveText('A client is in the middle of booking this day. Try again in a few minutes.')
  await expect(chip(page, '19:00')).toHaveAttribute('aria-pressed', 'false')
  // Once the client has finished or left, a reload of the list brings the times back.
  await f.publicApi.release(hold, key)
  await allTimes(page).getByRole('button', { name: 'Hide all times', exact: true }).click()
  await allTimes(page).getByRole('button', { name: 'Show all times', exact: true }).click()
  await expect(allTimes(page).getByRole('button', { name: '19:00 not a usual time', exact: true })).not.toHaveAttribute('aria-disabled', 'true')
})

test('a day off can be booked on purpose, and says it is not a working day', async ({ page }) => {
  await unwrap(f.admin.from('working_hours_overrides').upsert({ date: f.date, available: false, start_minutes: null, end_minutes: null, start_mode: 'flexible', fixed_start_minutes: null }))
  await newBooking(page)
  await expect(page.getByText('No available times. Choose another date.')).toBeVisible()
  await allTimes(page).getByRole('button', { name: 'Show all times', exact: true }).click()
  await expect(allTimes(page)).toContainText('This is not one of your working days.')
  await chip(page, '11:00').click()
  await expect(note(page).getByText('This is not one of your working days.')).toBeVisible()
  await page.getByRole('button', { name: 'Create booking', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect((await rowsOf()).map(row => row.start_minutes)).toEqual([660, 870])
})

for (const width of [320, 390]) {
  test(`all the times fit a ${width}px phone, with the note`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await newBooking(page)
    await showAll(page)
    await chip(page, '16:00').click()
    const fits = await page.evaluate(limit => {
      const box = document.querySelector('.anb-alltimes')
      const inside = [...box.querySelectorAll('button, .anb-time-note, p')].every(item => { const r = item.getBoundingClientRect(); return r.left >= -0.5 && r.right <= limit + 0.5 })
      return inside && document.documentElement.scrollWidth <= document.documentElement.clientWidth
    }, width)
    expect(fits).toBe(true)
  })
}
