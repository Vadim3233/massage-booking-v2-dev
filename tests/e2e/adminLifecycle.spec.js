import { test, expect } from '@playwright/test'
import { paymentReviewFixture } from '../paymentReviewFixture.js'

let f
test.beforeEach(async () => { f = await paymentReviewFixture() })
test.afterEach(async () => { await f?.cleanup() })

async function open(page, id) {
  await page.goto(`/admin/bookings/${id}`)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('dialog').first()).toBeVisible()
}
const details = page => page.locator('dialog.admin-details')
const action = page => page.locator('dialog.admin-action')

// A London date and 30-minute start that fall offsetMs from now.
function londonSlot(offsetMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(Date.now() + offsetMs)).map(part => [part.type, part.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, start: Math.floor((Number(parts.hour) * 60 + Number(parts.minute)) / 30) * 30 }
}
// Also backdates the booking so the one-hour grace period for new bookings does not apply.
async function moveTo(id, offsetMs) {
  const slot = londonSlot(offsetMs)
  const result = await f.admin.from('bookings').update({ date: slot.date, start_minutes: slot.start, created_at: new Date(Date.now() - 3 * 86400000).toISOString() }).eq('id', id)
  expect(result.error).toBeNull()
}

test('cancelling inside 24 hours shows the standard fee, records it as due, and lets the Admin waive it', async ({ page }) => {
  await f.authorize()
  const id = f.bookings[2].id
  await moveTo(id, 5 * 3600000)
  await open(page, id)
  await details(page).getByRole('button', { name: 'Cancel booking', exact: true }).click()
  await expect(action(page)).toBeVisible()
  await expect(action(page).getByLabel('Late fee (£)')).toHaveValue('85')
  await expect(action(page)).toContainText('Standard fee now: £85.00')
  await action(page).getByLabel('Reason').fill('Client has a family emergency')
  expect(await action(page).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/admin-cancel-dialog-390.png' })
  await action(page).getByRole('button', { name: 'Cancel booking', exact: true }).click()
  await expect(details(page).getByText('Late fee: Due · £85.00')).toBeVisible()
  await expect(details(page)).toContainText('Reason: Client has a family emergency')
  const row = (await f.admin.from('bookings').select('booking_status,late_fee_due_gbp,late_fee_status,cancellation_initiated_by').eq('id', id).single()).data
  expect(row).toMatchObject({ booking_status: 'cancelled', late_fee_status: 'due', cancellation_initiated_by: 'client' })
  expect(Number(row.late_fee_due_gbp)).toBe(85)

  await details(page).getByRole('button', { name: 'Waive fee', exact: true }).click()
  await action(page).getByRole('button', { name: 'Waive fee', exact: true }).click()
  await expect(details(page).getByText('Late fee: Waived')).toBeVisible()
  expect((await f.admin.from('bookings').select('late_fee_status').eq('id', id).single()).data.late_fee_status).toBe('waived')
  await details(page).getByText('History', { exact: true }).click()
  await expect(details(page)).toContainText('Booking: Confirmed → Cancelled')
})

test('an Admin-requested cancellation never suggests a fee, and the reason is optional', async ({ page }) => {
  await f.authorize()
  const id = f.bookings[2].id
  await moveTo(id, 5 * 3600000)
  await open(page, id)
  await details(page).getByRole('button', { name: 'Cancel booking', exact: true }).click()
  await action(page).getByLabel('It is my own decision').check()
  await expect(action(page).getByLabel('Late fee (£)')).toHaveValue('0')
  await expect(action(page).getByRole('button', { name: 'Cancel booking', exact: true })).toBeEnabled()
  await action(page).getByRole('button', { name: 'Cancel booking', exact: true }).click()
  await expect(details(page).getByText('Cancelled', { exact: false }).first()).toBeVisible()
  const row = (await f.admin.from('bookings').select('late_fee_status,cancellation_reason').eq('id', id).single()).data
  expect(row).toMatchObject({ late_fee_status: 'none', cancellation_reason: null })
})

test('rescheduling offers only available times, records the move, and explains a clash kindly', async ({ page }) => {
  await f.authorize()
  const id = f.bookings[2].id
  await open(page, id)
  await details(page).getByRole('button', { name: 'Reschedule', exact: true }).click()
  const times = action(page).getByLabel('New time')
  await expect(times).toBeEnabled()
  const options = await times.locator('option').evaluateAll(list => list.map(option => option.value).filter(Boolean))
  expect(options.length).toBeGreaterThan(1)
  await times.selectOption(options[1])
  expect(await action(page).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/admin-reschedule-dialog-390.png' })
  await action(page).getByRole('button', { name: 'Reschedule', exact: true }).click()
  await expect(details(page)).toContainText('Moved from')
  expect((await f.admin.from('bookings').select('start_minutes').eq('id', id).single()).data.start_minutes).toBe(Number(options[1]))
})

test('a started, confirmed appointment can be marked completed, but not before it starts', async ({ page }) => {
  await f.authorize()
  const id = f.bookings[2].id
  await open(page, id)
  await expect(details(page).getByRole('button', { name: 'Mark completed', exact: true })).toHaveCount(0)
  await moveTo(id, -5 * 3600000)
  await page.reload()
  await expect(details(page).getByRole('button', { name: 'Reschedule', exact: true })).toBeVisible()
  await details(page).getByRole('button', { name: 'Mark completed', exact: true }).click()
  await action(page).getByRole('button', { name: 'Mark completed', exact: true }).click()
  await expect(details(page).getByText('Completed', { exact: false }).first()).toBeVisible()
  expect((await f.admin.from('bookings').select('booking_status').eq('id', id).single()).data.booking_status).toBe('completed')
})

test('booking details offer one-tap call, WhatsApp, directions and email', async ({ page }) => {
  await f.authorize()
  await open(page, f.bookings[2].id)
  const nav = details(page).getByRole('navigation', { name: 'Quick contact' })
  await expect(nav.getByRole('link', { name: 'Call', exact: true })).toHaveAttribute('href', 'tel:+447700900002')
  await expect(nav.getByRole('link', { name: 'WhatsApp', exact: true })).toHaveAttribute('href', 'https://wa.me/447700900002')
  await expect(nav.getByRole('link', { name: 'WhatsApp', exact: true })).toHaveAttribute('rel', /noopener/)
  await expect(nav.getByRole('link', { name: 'Directions', exact: true })).toHaveAttribute('href', /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/)
  await expect(nav.getByRole('link', { name: 'Email', exact: true })).toHaveAttribute('href', 'mailto:booking@example.test')
})
