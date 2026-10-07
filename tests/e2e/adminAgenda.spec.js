import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'

let f
test.beforeEach(async () => { f = await adminFixture(5) })
test.afterEach(async () => { await f?.cleanup() })

async function login(page) {
  await page.goto('/admin/agenda')
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

test('Agenda lists bookings across days and returns to the same view after details', async ({ page }) => {
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)

  await expect(page).toHaveURL(/\/admin\/agenda$/)
  await expect(page.getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Calendar views' }).getByRole('link', { name: 'Agenda', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('navigation', { name: 'Admin navigation' }).getByRole('link', { name: 'Calendar', exact: true })).toHaveAttribute('aria-current', 'page')

  await expect(page.locator('.admin-agenda-day')).toHaveCount(2)
  await expect(page.locator('.admin-card')).toHaveCount(3)
  await expect(page.locator('.admin-card.cancelled')).toHaveCount(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  await page.locator('.admin-card').first().click()
  await expect(page.getByRole('dialog')).toContainText(f.bookings[0].booking_reference)
  await page.getByRole('button', { name: 'Close details' }).click()
  await expect(page).toHaveURL(/\/admin\/agenda$/)
  await expect(page.getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible()

  await page.getByRole('navigation', { name: 'Calendar views' }).getByRole('link', { name: 'Day', exact: true }).click()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByLabel('Calendar date', { exact: true })).toBeVisible()
})
