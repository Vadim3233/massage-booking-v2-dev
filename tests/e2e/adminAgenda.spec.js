import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'
import { dateLabel, shiftDate, today } from '../../src/admin/calendarPresentation.js'

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

// A booking made while away, some days after the fixture's day (a later month, for the Agenda that has read on that far).
async function bookLater(daysAhead) {
  const { id, created_at, updated_at, ...copy } = f.bookings[0]
  void id; void created_at; void updated_at
  await unwrap(f.admin.from('bookings').insert({ ...copy, date: shiftDate(f.date, daysAhead), start_minutes: 900, booking_reference: `LATE-${crypto.randomUUID()}` }))
}
// The server says no at once (the database client would otherwise try a lost connection again for several seconds on its own).
const refuse = route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: '22023', message: 'Test failure', details: null, hint: null }) })
async function openAgenda(page) {
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await expect(page.locator('.admin-card')).toHaveCount(3)
}

test('Refresh reads every month on show, not only the first', async ({ page }) => {
  await openAgenda(page)
  // Read on past the first month (the list also does this by itself as its end comes into view).
  await page.getByRole('button', { name: 'Load more upcoming appointments' }).click()
  await expect(page.locator('.admin-agenda-range')).not.toContainText(dateLabel(shiftDate(today(), 30), { day: 'numeric', month: 'short', year: 'numeric' }))
  await bookLater(40)
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.locator('.admin-card')).toHaveCount(4)
})

test('a refresh that fails just after waking is tried once more before anyone is told', async ({ page }) => {
  await openAgenda(page)
  await bookLater(0)
  // Coming back after a real absence reads the Agenda again by itself.
  await page.waitForTimeout(5300)
  // Every read is refused for the first second and a half, as it can be just after a phone wakes; the second try comes later and works.
  const until = Date.now() + 1500
  await page.route('**/rest/v1/bookings?*', route => (Date.now() < until ? refuse(route) : route.continue()))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('.admin-card')).toHaveCount(4, { timeout: 12000 })
  await expect(page.getByText('Could not refresh the agenda just now.')).toHaveCount(0)
})

test('a refresh that keeps failing says so quietly, keeps the list, and Try again works', async ({ page }) => {
  await openAgenda(page)
  let broken = true
  await page.route('**/rest/v1/bookings?*', route => (broken ? refuse(route) : route.continue()))
  // A refresh she asked for herself says so at once; only one nobody asked for is tried again quietly first.
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByText('Could not refresh the agenda just now.')).toBeVisible({ timeout: 1500 })
  await expect(page.getByRole('status').filter({ hasText: 'Could not refresh the agenda just now.' })).toBeVisible()
  await expect(page.locator('.admin-card')).toHaveCount(3)
  broken = false
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByText('Could not refresh the agenda just now.')).toHaveCount(0)
})
