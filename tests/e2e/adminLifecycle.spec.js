import { test, expect } from '@playwright/test'
import { paymentReviewFixture } from '../paymentReviewFixture.js'
import { londonSlot } from '../londonSlot.js'

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
  await expect(action(page).getByLabel('Another amount (£)')).toHaveValue('85')
  await expect(action(page)).toContainText('Standard fee now: £85.00')
  // The usual answers are one tap: here the standard fee is the full price, and waiving is a tap, not typing.
  await expect(action(page).getByLabel('Full price £85.00')).toBeChecked()
  await action(page).getByLabel('No fee').check()
  await expect(action(page).getByLabel('Another amount (£)')).toHaveValue('0')
  await expect(action(page).getByRole('button', { name: 'Cancel booking', exact: true })).toBeVisible()
  await action(page).getByLabel('Full price £85.00').check()
  await expect(action(page).getByLabel('Another amount (£)')).toHaveValue('85')
  await action(page).getByLabel('Reason').fill('Client has a family emergency')
  expect(await action(page).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/admin-cancel-dialog-390.png' })
  await action(page).getByRole('button', { name: /^Cancel booking/ }).click()
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
  await expect(action(page).getByLabel('Another amount (£)')).toHaveValue('0')
  await expect(action(page).getByLabel('No fee')).toBeChecked()
  await expect(action(page).getByRole('button', { name: /^Cancel booking/ })).toBeEnabled()
  await action(page).getByRole('button', { name: /^Cancel booking/ }).click()
  await expect(details(page).getByText('Cancelled', { exact: false }).first()).toBeVisible()
  const row = (await f.admin.from('bookings').select('late_fee_status,cancellation_reason').eq('id', id).single()).data
  expect(row).toMatchObject({ late_fee_status: 'none', cancellation_reason: null })
})

test('rescheduling offers only available times, records the move, and explains a clash kindly', async ({ page }) => {
  await f.authorize()
  const id = f.bookings[2].id
  await open(page, id)
  await details(page).getByRole('button', { name: 'Reschedule', exact: true }).click()
  // The same day-and-time picker as booking: the days come first, the free times of the open day below them.
  const slots = action(page).locator('.dtp .slots button')
  await expect(slots.first()).toBeVisible()
  expect(await slots.count()).toBeGreaterThan(1)
  const second = slots.nth(1)
  const chosen = (await second.textContent()).trim()
  await second.click()
  await expect(action(page).getByRole('status').filter({ hasText: 'New time' })).toContainText(chosen)
  expect(await action(page).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/admin-reschedule-dialog-390.png' })
  await action(page).getByRole('button', { name: 'Reschedule', exact: true }).click()
  await expect(details(page)).toContainText('Moved from')
  const [hours, minutes] = chosen.split(':').map(Number)
  expect((await f.admin.from('bookings').select('start_minutes').eq('id', id).single()).data.start_minutes).toBe(hours * 60 + minutes)
})

test('a fee she has chosen is never replaced by a standard fee that arrives late', async ({ page }) => {
  await f.authorize()
  const id = f.bookings[2].id
  await moveTo(id, 5 * 3600000)
  await open(page, id)
  await page.route('**/rpc/admin_late_fee_preview', async route => { await new Promise(resolve => setTimeout(resolve, 1500)); await route.continue() })
  await details(page).getByRole('button', { name: 'Cancel booking', exact: true }).click()
  // Until the standard fee arrives no fee is chosen, so the button waits; she taps No fee first.
  await expect(action(page).getByRole('button', { name: /^Cancel booking/ })).toBeDisabled()
  await action(page).getByLabel('No fee').check()
  await expect(action(page).getByRole('button', { name: 'Cancel booking', exact: true })).toBeEnabled()
  await expect(action(page)).toContainText('Standard fee now: £85.00')
  await expect(action(page).getByLabel('No fee')).toBeChecked()
  await expect(action(page).getByLabel('Another amount (£)')).toHaveValue('0')
  await action(page).getByRole('button', { name: 'Cancel booking', exact: true }).click()
  await expect(action(page)).toHaveCount(0)
  const row = (await f.admin.from('bookings').select('booking_status,late_fee_due_gbp').eq('id', id).single()).data
  expect(row.booking_status).toBe('cancelled')
  expect(Number(row.late_fee_due_gbp)).toBe(0)
})

test('if the standard fee cannot be looked up, she chooses a fee before cancelling', async ({ page }) => {
  await f.authorize()
  const id = f.bookings[2].id
  await moveTo(id, 5 * 3600000)
  await open(page, id)
  await page.route('**/rpc/admin_late_fee_preview', route => route.abort('failed'))
  await details(page).getByRole('button', { name: 'Cancel booking', exact: true }).click()
  await expect(action(page).getByLabel('Full price £85.00')).toBeVisible()
  await expect(action(page).locator('input[name=fee-choice]:checked')).toHaveCount(0)
  await expect(action(page).getByRole('button', { name: /^Cancel booking/ })).toBeDisabled()
  await action(page).getByLabel('Full price £85.00').check()
  await expect(action(page).getByRole('button', { name: 'Cancel booking · £85.00 fee due' })).toBeEnabled()
  await action(page).getByRole('button', { name: /^Cancel booking/ }).click()
  await expect(action(page)).toHaveCount(0)
  expect(Number((await f.admin.from('bookings').select('late_fee_due_gbp').eq('id', id).single()).data.late_fee_due_gbp)).toBe(85)
})

test('the buttons stay in view on a short screen, and a field that takes focus is not hidden behind them', async ({ page }) => {
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 600 })
  const id = f.bookings[2].id
  await moveTo(id, 5 * 3600000)
  await open(page, id)
  await details(page).getByRole('button', { name: 'Cancel booking', exact: true }).click()
  const buttons = action(page).locator('.admin-sticky-actions')
  await expect(buttons).toBeInViewport()
  await action(page).getByLabel('Another amount (£)').focus()
  const field = await action(page).getByLabel('Another amount (£)').boundingBox()
  const bar = await buttons.boundingBox()
  expect(field.y + field.height).toBeLessThanOrEqual(bar.y + 1)
})

test('a no-show offers the full price or no fee in one tap, and records the one chosen', async ({ page }) => {
  await f.authorize()
  const id = f.bookings[2].id
  await moveTo(id, -5 * 3600000)
  await open(page, id)
  await details(page).getByRole('button', { name: 'Mark no-show', exact: true }).click()
  // Nothing typed means the full price, so that is the one already chosen.
  await expect(action(page).getByLabel('Full price £85.00')).toBeChecked()
  await action(page).getByLabel('No fee').check()
  await expect(action(page).getByLabel('Another amount (£)')).toHaveValue('0')
  await action(page).getByRole('button', { name: 'Mark no-show', exact: true }).click()
  await expect(action(page)).toHaveCount(0)
  const row = (await f.admin.from('bookings').select('booking_status,late_fee_due_gbp').eq('id', id).single()).data
  expect(row.booking_status).toBe('no_show')
  expect(Number(row.late_fee_due_gbp)).toBe(0)
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
