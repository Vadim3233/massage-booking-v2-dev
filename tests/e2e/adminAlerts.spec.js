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
  await expect(list.filter({ hasText: 'New booking request' })).toContainText('Waiting for payment')
  await expect(list.filter({ hasText: 'says the transfer is made' })).toContainText('Check your bank, then verify the payment.')
  await list.filter({ hasText: 'New booking request' }).getByRole('button').click()
  await expect(page.locator('dialog.admin-details')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/admin/bookings/${f.bookings[0].id}$`))
  await page.getByRole('button', { name: 'Close details' }).click()
  await expect(nav(page).getByLabel('1 unread')).toBeVisible()
  await page.getByRole('button', { name: 'Mark all as read' }).click()
  await expect(nav(page).getByLabel(/unread/)).toHaveCount(0)
  await expect(page.locator('.admin-alerts li.is-unread')).toHaveCount(0)
})

test('with nothing to report the page says so kindly, and the navigation fits a small phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await f.authorize()
  await signIn(page)
  await expect(page.getByText('Nothing yet. New bookings and client changes will appear here.')).toBeVisible()
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
  await expect(page.locator('.admin-alerts li')).toContainText('Late fee of £85.00 recorded as due.')
})
