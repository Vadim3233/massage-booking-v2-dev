import { test, expect } from '@playwright/test'
import { paymentReviewFixture } from '../paymentReviewFixture.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'

// Before a cancellation is confirmed, the screen says what happens to the money; the refund the database then records is the one it said. A cancelled
// booking with a refund to send has Record refund on its card in the Calendar, which clears the reminder.
let f
test.beforeEach(async () => { f = await paymentReviewFixture() })
test.afterEach(async () => { await f?.cleanup() })

async function signIn(page, path) {
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
const details = page => page.locator('dialog.admin-details')
const action = page => page.locator('dialog.admin-action')
const outcome = page => action(page).locator('.admin-money-outcome')
const row = id => unwrap(f.admin.from('bookings').select('booking_status,refund_due_gbp,late_fee_due_gbp,booking_payments(status)').eq('id', id).single())

test('a paid booking: the money outcome follows the fee chosen, and the refund recorded is the one said', async ({ page }) => {
  await f.authorize()
  await f.prepare(2, 'bank_transfer', 'confirmed', 'paid')
  const id = f.bookings[2].id
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page, `/admin/bookings/${id}`)
  await details(page).getByRole('button', { name: 'Cancel booking', exact: true }).click()
  await action(page).getByLabel('It is my own decision').check()
  await expect(action(page).getByLabel('No fee')).toBeChecked()
  await expect(outcome(page)).toContainText(/No cancellation fee – .+ gets a full £85\.00 refund/)
  await expect(outcome(page)).toContainText('You send it yourself, then press Record refund.')
  await action(page).getByRole('radio', { name: /Full price/ }).check()
  await expect(outcome(page)).toContainText('Late cancellation – you keep the full £85.00, nothing to refund')
  await expect(outcome(page)).not.toContainText('Record refund')
  await action(page).getByLabel('Another amount (£)').fill('30')
  await expect(outcome(page)).toContainText('Late cancellation – you keep £30.00, refund £55.00')
  // The button says the same: on a paid booking the fee is kept from the payment, not due.
  await expect(action(page).getByRole('button', { name: 'Cancel booking · you keep £30.00' })).toBeEnabled()
  await page.screenshot({ path: 'test-results/cancel-money-outcome.png', fullPage: true })
  await action(page).getByRole('button', { name: /^Cancel booking/ }).click()
  await expect.poll(async () => (await row(id)).booking_status).toBe('cancelled')
  expect(await row(id)).toMatchObject({ refund_due_gbp: 55, late_fee_due_gbp: 30 })
})

test('an unpaid booking: nothing to refund', async ({ page }) => {
  await f.authorize()
  const id = f.bookings[0].id
  await signIn(page, `/admin/bookings/${id}`)
  await details(page).getByRole('button', { name: 'Cancel booking', exact: true }).click()
  await action(page).getByLabel('It is my own decision').check()
  await expect(outcome(page)).toHaveText(/No money has been paid – nothing to refund$/)
  await action(page).getByRole('button', { name: /^Cancel booking/ }).click()
  await expect.poll(async () => (await row(id)).booking_status).toBe('cancelled')
  expect(Number((await row(id)).refund_due_gbp ?? 0)).toBe(0)
})

test('a cancelled card with a refund to send has Record refund, which clears the reminder', async ({ page }) => {
  await f.authorize()
  await f.prepare(2, 'bank_transfer', 'confirmed', 'paid')
  const id = f.bookings[2].id
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page, `/admin/bookings/${id}`)
  await details(page).getByRole('button', { name: 'Cancel booking', exact: true }).click()
  await action(page).getByLabel('It is my own decision').check()
  await action(page).getByRole('button', { name: /^Cancel booking/ }).click()
  await expect.poll(async () => Number((await row(id)).refund_due_gbp)).toBe(85)
  await page.goto('/admin/agenda')
  const button = page.getByRole('button', { name: /^Record refund sent to / })
  await expect(button).toHaveCount(1)
  await expect(page.locator('.admin-card-wrap', { has: button }).locator('.admin-status')).toContainText('refund £85.00 to send')
  await button.scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'test-results/cancelled-card-refund.png', fullPage: true })
  await button.click()
  await expect(action(page)).toContainText('Confirm that you have sent the refund')
  await action(page).getByRole('button', { name: 'Record refund sent', exact: true }).click()
  await expect.poll(async () => Number((await row(id)).refund_due_gbp)).toBe(0)
  expect((await row(id)).booking_payments.status).toBe('refunded')
  await expect(page.getByRole('button', { name: /^Record refund sent to / })).toHaveCount(0)
})
