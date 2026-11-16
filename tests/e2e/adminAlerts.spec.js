import { test, expect } from '@playwright/test'
import { paymentReviewFixture } from '../paymentReviewFixture.js'

let f
test.beforeEach(async () => { f = await paymentReviewFixture() })
test.afterEach(async () => { await f?.cleanup() })

async function signIn(page, path = '/admin/alerts') {
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
async function emit(type, bookingId, payload = {}) {
  const { error } = await f.admin.from('event_outbox').insert({ event_type: type, aggregate_type: 'booking', aggregate_id: bookingId, payload })
  expect(error).toBeNull()
}
const nav = page => page.getByRole('navigation', { name: 'Admin navigation' })

test('a new booking shows as an unread badge and an alert that opens the exact booking', async ({ page }) => {
  await f.authorize()
  await emit('booking.created', f.bookings[0].id, { booking_status: 'awaiting_transfer' })
  await emit('booking.transfer_declared', f.bookings[1].id, { method: 'bank_transfer' })
  await signIn(page)
  await expect(page.getByRole('heading', { name: 'Alerts' })).toBeVisible()
  await expect(nav(page).getByLabel('2 unread')).toBeVisible()
  const list = page.locator('.admin-alerts li')
  await expect(list).toHaveCount(2)
  // Each alert is two short lines until tapped: what happened, then who and which day.
  const created = list.filter({ hasText: 'New booking request' }), declared = list.filter({ hasText: 'Transfer made' })
  await expect(created).not.toContainText('Waiting for payment')
  await declared.locator('.admin-alert-row').click()
  await expect(declared).toContainText('Check your bank, then verify the payment.')
  await expect(nav(page).getByLabel('1 unread')).toBeVisible()
  await created.locator('.admin-alert-row').click()
  await expect(created).toContainText('Waiting for payment')
  await created.getByRole('button', { name: 'Open booking' }).click()
  await expect(page.locator('dialog.admin-details')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/admin/bookings/${f.bookings[0].id}$`))
  await page.getByRole('button', { name: 'Close details' }).click()
  await expect(nav(page).getByLabel(/unread/)).toHaveCount(0)
  await emit('booking.created', f.bookings[2].id, { booking_status: 'awaiting_transfer' })
  await page.getByRole('button', { name: 'Refresh alerts' }).click()
  await expect(nav(page).getByLabel('1 unread')).toBeVisible()
  await page.getByRole('button', { name: 'Mark all as read' }).click()
  await expect(nav(page).getByLabel(/unread/)).toHaveCount(0)
  await expect(page.locator('.admin-alerts li.is-unread')).toHaveCount(0)
})

test('each thing that happened to a booking is its own line, with what happened before it', async ({ page }) => {
  await f.authorize()
  await emit('booking.created', f.bookings[0].id, { booking_status: 'awaiting_transfer' })
  await emit('booking.transfer_declared', f.bookings[0].id, { method: 'bank_transfer' })
  await signIn(page)
  const list = page.locator('.admin-alerts li')
  await expect(list).toHaveCount(2)
  await expect(list.first()).toContainText('Transfer made')
  await expect(list.first()).toContainText('Client')
  await expect(nav(page).getByLabel('2 unread')).toBeVisible()
  // Reading the list again is held back for the rest of the test, so what the row says is what the page itself did on opening the line.
  await page.route('**/rpc/admin_activity_list*', () => new Promise(() => {}))
  await list.first().locator('.admin-alert-row').click()
  await expect(list.first()).toContainText('says the transfer is made')
  await expect(list.first()).toContainText('Earlier on this booking')
  await expect(list.first()).toContainText('New booking request')
  // The line stops being new at once; the other one is still new.
  await expect(page.locator('.admin-alerts li.is-unread')).toHaveCount(1)
  await expect(nav(page).getByLabel('1 unread')).toBeVisible()
  await list.first().getByRole('button', { name: 'Open booking' }).click()
  await expect(page.locator('dialog.admin-details')).toBeVisible()
  // The booking's History tells its story, oldest first.
  await expect(page.locator('.activity-history')).toContainText('New booking request')
  await expect(page.locator('.activity-history')).toContainText('Transfer made')
  await page.getByRole('button', { name: 'Close details' }).click()
})

test('with nothing to report the page says so kindly, and the navigation fits a small phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await f.authorize()
  await signIn(page)
  await expect(page.getByText('Nothing yet. New bookings and changes will appear here.')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const boxes = await nav(page).locator('a, button').evaluateAll(items => items.map(item => { const r = item.getBoundingClientRect(); return [r.left, r.right] }))
  expect(boxes.every(([left, right]) => left >= 0 && right <= 320)).toBe(true)
})

test('only events the Admin needs to hear about create alerts, and never the Admin\'s own actions', async ({ page }) => {
  await f.authorize()
  await emit('booking.completed', f.bookings[0].id)
  await emit('booking.cancelled', f.bookings[0].id, { initiated_by: 'admin' })
  await signIn(page)
  await expect(page.getByText('Nothing yet.')).toBeVisible()
  await emit('booking.cancelled', f.bookings[1].id, { initiated_by: 'client', source: 'client', late_fee_due_gbp: 85, refund_due_gbp: 0 })
  await page.getByRole('button', { name: 'Refresh alerts' }).click()
  await expect(page.locator('.admin-alerts li')).toHaveCount(1)
  await page.locator('.admin-alerts .admin-alert-row').click()
  await expect(page.locator('.admin-alerts li')).toContainText('Late fee of £85.00 recorded as due.')
})

test('alerts sit under the day they were raised on, with the time on each card', async ({ page }) => {
  await f.authorize()
  await emit('booking.created', f.bookings[0].id, { booking_status: 'awaiting_transfer' })
  await emit('booking.created', f.bookings[1].id, { booking_status: 'awaiting_transfer' })
  // The second booking's alert was raised three days ago.
  const earlier = new Date(Date.now() - 3 * 86400000).toISOString()
  const moved = await f.admin.from('notification_deliveries').update({ created_at: earlier }).eq('link_path', `/admin/bookings/${f.bookings[1].id}`)
  expect(moved.error).toBeNull()
  await signIn(page)
  const days = page.locator('.admin-alerts-day')
  await expect(days).toHaveCount(2)
  await expect(days.first().getByRole('heading', { level: 2 })).toContainText('Today')
  await expect(days.first().locator('li')).toHaveCount(1)
  await expect(days.last().getByRole('heading', { level: 2 })).not.toContainText('Today')
  await expect(days.last().locator('li')).toHaveCount(1)
  // The day is in the heading, so a card only needs the time.
  await expect(days.last().locator('li .admin-alert-side small')).toHaveText(/^\d\d:\d\d$/)
  await expect(days.last().locator('li.is-unread')).toHaveCount(1)
})
