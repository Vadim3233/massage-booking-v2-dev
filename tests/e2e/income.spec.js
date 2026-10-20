import fs from 'node:fs'
import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'
import { shiftDate, today } from '../../src/admin/calendarPresentation.js'

// More › Income. The figures are the database's (checked in supabase/tests/income.test.sql); this checks the screen around them. The shared
// test database may hold other bookings, so the checks look for this test's own bookings rather than exact totals.
let f
test.beforeEach(async () => { f = await adminFixture(5) })
test.afterEach(async () => { await f?.cleanup() })

const monthName = date => new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'))

test('Income: the month\'s money, the bookings behind it, money owed, the tax year and the accountant\'s file', async ({ page }) => {
  await f.authorize()
  const now = today()
  // Cash received today (income), and cash agreed yesterday but not marked received (money owed).
  await f.admin.from('bookings').update({ date: now, start_minutes: 0 }).eq('id', f.bookings[2].id)
  await f.admin.from('booking_payments').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('booking_id', f.bookings[2].id)
  await f.admin.from('bookings').update({ date: shiftDate(now, -1) }).eq('id', f.bookings[0].id)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/admin/more')
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('region', { name: 'Money' }).getByRole('link', { name: 'Income' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Income' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Month' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('heading', { level: 2, name: monthName(now) })).toBeVisible()
  const list = page.getByRole('region', { name: 'Bookings' })
  const mine = list.getByRole('button', { name: /^AlexandraAlexandra.*Cash.*£85\.00$/ })
  await expect(mine).toBeVisible()
  await expect(page.getByText('Bank transfer', { exact: true })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Income in each part of the period' }).getByRole('listitem').first()).toBeVisible()
  await page.screenshot({ path: 'test-results/income-month.png', fullPage: true })

  // Money owed to you: yesterday's cash, not marked received, opens its booking.
  await page.getByText('Money owed to you').click()
  const owed = page.locator('.admin-income-owed').getByRole('button', { name: /^AlexandraAlexandra.*cash not marked received.*£85\.00$/ })
  await expect(owed).toBeVisible()
  await owed.click()
  await expect(page.locator('dialog.admin-details')).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { level: 1, name: 'Income' })).toBeVisible()

  // The accountant's file for the month lists this booking.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download for accountant' }).click()])
  expect(download.suggestedFilename()).toBe(`vadmassage-income-${now.slice(0, 7)}.csv`)
  const csv = fs.readFileSync(await download.path(), 'utf8')
  expect(csv.split('\r\n')[0]).toBe('Date,Booking reference,Client,Method,Amount received,Refund,Net')
  expect(csv).toContain(`${now},${f.bookings[2].booking_reference},`)
  expect(csv).toContain(',Cash,85.00,0.00,85.00')

  // The arrows move a month at a time; the Year tab has a tax year.
  await page.getByRole('button', { name: 'Previous period' }).click()
  await expect(page.getByRole('heading', { level: 2, name: monthName(shiftDate(now.slice(0, 8) + '01', -1)) })).toBeVisible()
  await page.getByRole('tab', { name: 'Year' }).click()
  await expect(page.getByRole('heading', { level: 2, name: now.slice(0, 4) })).toBeVisible()
  await page.getByRole('button', { name: 'Tax year' }).click()
  const taxStart = now.slice(5) >= '04-06' ? Number(now.slice(0, 4)) : Number(now.slice(0, 4)) - 1
  await expect(page.getByRole('heading', { level: 2, name: `Tax year ${taxStart}/${String(taxStart + 1).slice(2)}` })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Income in each part of the period' }).getByRole('listitem')).toHaveCount(13)
  await page.screenshot({ path: 'test-results/income-tax-year.png', fullPage: true })
})

test('a client cannot reach the income figures', async () => {
  const { error } = await f.client.rpc('admin_income_summary', { p_kind: 'month', p_anchor: today() })
  expect(error?.message).toBe('Admin authorization required')
})
