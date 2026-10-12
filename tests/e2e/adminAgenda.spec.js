import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'

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

  // Today is always on the page as a fixed point, even when nothing is booked; the other days are the ones with bookings.
  await expect(page.locator('.admin-agenda-day.is-today')).toHaveCount(1)
  await expect(page.locator('.admin-agenda-day:has(.admin-card)')).toHaveCount(2)
  await expect(page.locator('.admin-card')).toHaveCount(3)
  await expect(page.locator('.admin-card.cancelled')).toHaveCount(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  await page.locator('.admin-card').first().click()
  await expect(page.getByRole('dialog')).toContainText(f.bookings[0].booking_reference)
  await page.getByRole('button', { name: 'Close details' }).click()
  await expect(page).toHaveURL(/\/admin\/agenda$/)
  await expect(page.getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible()

  await page.getByRole('navigation', { name: 'Calendar views' }).getByRole('link', { name: 'Day', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/day$/)
  await expect(page.getByLabel('Calendar date', { exact: true })).toBeVisible()
})

test('opening the Admin and pressing Calendar both show the Agenda, and Day is one tap away', async ({ page }) => {
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/admin')
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible()
  const views = page.getByRole('navigation', { name: 'Calendar views' })
  await views.getByRole('link', { name: 'Day', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/day$/)
  await expect(page.getByLabel('Calendar date', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: /^To check/ }).click()
  await page.getByRole('navigation', { name: 'Admin navigation' }).getByRole('link', { name: 'Calendar', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible()
})

// Someone books while the Admin is in another app (her banking app, WhatsApp). Coming back shows it without a tap,
// and the list she was looking at never blanks out while it is read again.
async function bookWhileAway(page) {
  const { id, created_at, updated_at, ...copy } = f.bookings[0]
  void id; void created_at; void updated_at
  await page.evaluate(() => {
    window.__blanked = false
    new MutationObserver(() => { if (document.querySelector('.skeleton-rows')) window.__blanked = true }).observe(document.body, { childList: true, subtree: true })
  })
  await unwrap(f.admin.from('bookings').insert({ ...copy, start_minutes: 900, booking_reference: `LATE-${crypto.randomUUID()}` }))
  // Coming back within a few seconds is not worth another read; a real absence is.
  await page.waitForTimeout(5300)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
}

test('the Agenda shows a booking made while the Admin was away, without blanking out', async ({ page }) => {
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await expect(page.locator('.admin-card')).toHaveCount(3)
  await bookWhileAway(page)
  await expect(page.locator('.admin-card')).toHaveCount(4)
  expect(await page.evaluate(() => window.__blanked)).toBe(false)
})

test('the Day view shows a booking made while the Admin was away, without blanking out', async ({ page }) => {
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await page.getByRole('navigation', { name: 'Calendar views' }).getByRole('link', { name: 'Day', exact: true }).click()
  await page.getByLabel('Calendar date', { exact: true }).fill(f.date)
  await expect(page.locator('.admin-card')).toHaveCount(2)
  await bookWhileAway(page)
  await expect(page.locator('.admin-card')).toHaveCount(3)
  expect(await page.evaluate(() => window.__blanked)).toBe(false)
})
