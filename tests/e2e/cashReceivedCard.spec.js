import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'
import { shiftDate, today } from '../../src/admin/calendarPresentation.js'

// Cash agreed for an appointment counts as income only once it is received: after the appointment has started, its card offers Cash received.
// The fixture's first booking is cash, approved (agreed, not yet received), at 10:00.
let f
test.beforeEach(async () => { f = await adminFixture(5) })
test.afterEach(async () => { await f?.cleanup() })

async function openDay(page, date) {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/admin?date=${date}`)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
const cashButton = page => page.getByRole('button', { name: /^Mark £85\.00 cash received from / })

test('an appointment still to come has no Cash received button', async ({ page }) => {
  await f.authorize()
  await openDay(page, f.date)
  await expect(page.locator('.admin-card').first()).toBeVisible()
  await expect(cashButton(page)).toHaveCount(0)
})

test('after the appointment, Cash received asks first, then records the cash as received', async ({ page }) => {
  await f.authorize()
  const yesterday = shiftDate(today(), -1)
  await f.admin.from('bookings').update({ date: yesterday }).eq('id', f.bookings[0].id)
  const questions = []
  let answer = false
  page.on('dialog', dialog => { questions.push(dialog.message()); answer ? dialog.accept() : dialog.dismiss() })
  await openDay(page, yesterday)
  await expect(cashButton(page)).toBeVisible()
  await page.screenshot({ path: 'test-results/cash-received-card.png' })
  // Saying no changes nothing.
  await cashButton(page).click()
  expect(questions).toEqual([expect.stringMatching(/^Mark £85\.00 cash received from Alexandra/)])
  expect((await f.admin.from('booking_payments').select('status').eq('booking_id', f.bookings[0].id).single()).data.status).toBe('approved')
  answer = true
  await cashButton(page).click()
  await expect(page.getByText(/^Cash received · /)).toBeVisible()
  await expect(cashButton(page)).toHaveCount(0)
  const payment = (await f.admin.from('booking_payments').select('status,paid_at').eq('booking_id', f.bookings[0].id).single()).data
  expect(payment.status).toBe('paid')
  expect(payment.paid_at).not.toBeNull()
})
