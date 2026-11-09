import { test, expect } from '@playwright/test'
import { chooseLength } from '../bookingSteps.js'
import { localFixture } from '../localSupabase.js'
import { londonDate } from '../../src/client/booking/bookingDraft.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'

// Booking several sessions (ADR-097): a client pays for one session at a time, each later one after the session before it.
let fixture
test.beforeEach(async () => { fixture = await localFixture(25) })
test.afterEach(async ({ page }) => {
  if (fixture && page.url().startsWith('http://127.0.0.1:5174')) fixture.trackKey(await page.evaluate(() => localStorage.getItem('vad-v2-hold-client-v1')))
  await fixture?.cleanup()
})

// A paid session of the client's. A new client can hold only one appointment until their first is completed and paid
// (new_client_booking_limit), so a returning client has a completed one in the past.
async function session(offset, status) {
  const id = crypto.randomUUID()
  await unwrap(fixture.admin.from('bookings').insert({ id, booking_reference: `EARLY-${id.slice(0, 6)}`, client_id: fixture.profile.client_id, service_area_id: fixture.ids.area,
    date: londonDate(offset), start_minutes: 600, treatment_duration_minutes: 60, booking_status: status, source_channel: 'test', address_line_1_snapshot: '10 Browser Street',
    city_snapshot: 'London', postcode_snapshot: 'SW1A 1AA', service_area_name_snapshot: 'Integration area', total_gbp: 105, service_subtotal_gbp: 85, booking_email_snapshot: fixture.email }))
  await unwrap(fixture.admin.from('booking_payments').insert({ booking_id: id, method: 'bank_transfer', status: 'paid', amount_gbp: 105, payment_reference: `EARLY-${id.slice(0, 6)}`, paid_at: new Date().toISOString() }))
  return id
}
// A returning client's earlier session, confirmed and paid, five days before the one being booked.
async function earlierSession() {
  await session(-30, 'completed')
  return session(20, 'confirmed')
}

async function toPayment(page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Integration area/ }).click()
  await page.getByRole('button', { name: /Integration massage/ }).click()
  await chooseLength(page, 60, 1)
  await page.getByLabel('Appointment date').fill(fixture.date)
  await page.getByRole('button', { name: '10:00', exact: true }).click()
  await page.getByRole('button', { name: 'Review booking', exact: true }).click()
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await page.getByRole('button', { name: 'Sign in with email' }).click()
  await page.getByLabel('Email address', { exact: true }).fill(fixture.email)
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Address', exact: true }).fill('10 Browser Street, London, SW1A 1AA')
  await page.getByRole('button', { name: 'Continue to payment' }).click()
}

test('a later session has nothing to pay yet, is confirmed straight away, and says when it is paid', async ({ page }) => {
  const errors = []; page.on('pageerror', (error) => errors.push(error.message))
  const earlier = await earlierSession()
  await toPayment(page)
  await expect(page.getByRole('heading', { name: 'Nothing to pay yet' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'You pay for one session at a time' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy payment reference' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Bank transfer/ })).toContainText('After your')
  await page.screenshot({ path: 'test-results/pay-after-payment-step.png', fullPage: true })
  await page.getByRole('button', { name: 'Book this session' }).click()
  await expect(page.getByLabel('I understand the payment and cancellation terms.')).toBeFocused()
  await page.getByLabel('I understand the payment and cancellation terms.').check()
  await page.getByRole('button', { name: 'Book this session' }).click()
  await expect(page.getByRole('heading', { name: 'Your appointment is confirmed' })).toBeVisible()
  await expect(page.getByText(/^Nothing to pay yet\. After your \d+ \w+ session, I'll send you the details to pay £\d+\.\d\d for this one\.$/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Book another session' })).toBeVisible()
  await page.screenshot({ path: 'test-results/pay-after-confirmed.png', fullPage: true })
  const [booking] = await unwrap(fixture.admin.from('bookings').select('booking_status,pay_after_booking_id,booking_payments(status)').eq('client_id', fixture.profile.client_id).eq('date', fixture.date))
  expect(booking).toMatchObject({ booking_status: 'confirmed', pay_after_booking_id: earlier, booking_payments: { status: 'awaiting_transfer' } })

  // Booking another session goes straight to the times, with the same treatment and length.
  await page.getByRole('button', { name: 'Book another session' }).click()
  await expect(page.getByRole('heading', { name: 'Choose date and time' })).toBeVisible()
  await page.goto('/account')
  await expect(page.locator('.account-pay').filter({ hasText: /Pay after your \d+ \w+ session/ })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Book another session' })).toBeVisible()
  await page.screenshot({ path: 'test-results/pay-after-account.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(errors).toEqual([])
})

test('a client can still pay for a later session now, the usual way', async ({ page }) => {
  await earlierSession()
  await toPayment(page)
  await page.getByRole('button', { name: "I'd rather pay for this one now" }).click()
  await expect(page.getByRole('heading', { name: 'One last step' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy payment reference' })).toBeVisible()
})

test('a first session is paid in the usual way', async ({ page }) => {
  await toPayment(page)
  await expect(page.getByRole('heading', { name: 'One last step' })).toBeVisible()
  await expect(page.getByRole('button', { name: "I'd rather pay for this one now" })).toHaveCount(0)
})
