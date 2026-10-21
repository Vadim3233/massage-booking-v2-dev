import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'

// The sign-in check never hangs for good: when the "are you the Admin?" question does not come back, the page says so after a few seconds,
// then offers Retry, and works again once the connection does.
let f
test.beforeEach(async () => { f = await adminFixture(5) })
test.afterEach(async () => { await f?.cleanup() })

test('a sign-in check that does not come back offers a way out, and Retry works once the connection is back', async ({ page }) => {
  test.setTimeout(60000)
  await f.authorize()
  // The question to the database is held and never answered, as on a stalled connection.
  await page.route('**/rest/v1/rpc/is_booking_admin', () => {})
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/admin/agenda')
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByText('Checking authentication…')).toBeVisible()
  await expect(page.getByText('This is taking longer than usual.')).toBeVisible({ timeout: 12000 })
  await expect(page.getByRole('button', { name: 'Reload the page' })).toBeVisible()
  await page.screenshot({ path: 'test-results/admin-slow-check.png' })
  // The question gives up by itself and says why, with Retry.
  await expect(page.getByText('The connection is slow, so your sign-in could not be checked.')).toBeVisible({ timeout: 12000 })
  await page.unroute('**/rest/v1/rpc/is_booking_admin')
  await page.getByRole('button', { name: 'Retry authentication' }).click()
  await expect(page.getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible()
})
