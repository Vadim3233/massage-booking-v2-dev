import { test, expect } from '@playwright/test'
import { localFixture } from '../localSupabase.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'

let f
test.beforeEach(async () => { f = await localFixture(28) })
test.afterEach(async () => { await f?.cleanup() })

async function booking(overrides = {}) {
  const row = await unwrap(f.admin.from('bookings').insert({
    client_id: f.profile.client_id, service_area_id: f.ids.area, date: f.date, start_minutes: 600, treatment_duration_minutes: 60, booking_status: 'confirmed',
    source_channel: 'web', address_line_1_snapshot: '1 Test Road', city_snapshot: 'London', postcode_snapshot: 'SW1A1AA', service_area_name_snapshot: 'Integration area',
    service_subtotal_gbp: 85, total_gbp: 85, booking_email_snapshot: f.email, booking_reference: `ACC-${crypto.randomUUID()}`, ...overrides }).select().single())
  await unwrap(f.admin.from('booking_sessions').insert({ booking_id: row.id, position: 1, service_id: f.ids.service, duration_minutes: 60, service_name_snapshot: 'Integration massage', unit_price_gbp: 85 }))
  await unwrap(f.admin.from('booking_payments').insert({ booking_id: row.id, method: 'cash', status: 'approved', amount_gbp: 85 }))
  return row
}
async function signIn(page, path = '/account') {
  await page.goto(path)
  await page.getByLabel('Email address', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
function londonSlot(offsetMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(Date.now() + offsetMs)).map(part => [part.type, part.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, start: Math.floor((Number(parts.hour) * 60 + Number(parts.minute)) / 30) * 30 }
}

test('a signed-out visitor is asked to sign in, and sees their booking afterwards', async ({ page }) => {
  await booking()
  await page.goto('/account')
  await expect(page.getByRole('heading', { name: 'Sign in to see your bookings' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue as guest' })).toHaveCount(0)
  await signIn(page)
  await expect(page.getByRole('heading', { name: 'Your bookings' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Integration massage · 60 min/ })).toBeVisible()
})

test('changing the time well in advance is free and the new time is shown', async ({ page }) => {
  const b = await booking()
  await signIn(page, `/account?booking=${b.id}`)
  await expect(page.getByRole('heading', { name: 'Confirmed' })).toBeVisible()
  await expect(page.getByText(/No charge\. Changes are free until/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Change the time', exact: true }).click()
  await page.getByLabel('New date').fill(f.date)
  const slots = page.getByRole('group', { name: 'Available times' }).getByRole('button')
  await expect(slots.first()).toBeVisible()
  const label = (await slots.nth(1).textContent()).trim()
  await slots.nth(1).click()
  await page.getByRole('button', { name: 'Move my appointment', exact: true }).click()
  await expect(page.getByText('Your appointment has been moved.')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Appointment summary' })).toContainText(label)
  const row = (await f.admin.from('bookings').select('start_minutes,late_fee_status').eq('id', b.id).single()).data
  expect(row.late_fee_status).toBe('none')
  expect(`${String(Math.floor(row.start_minutes / 60)).padStart(2, '0')}:${String(row.start_minutes % 60).padStart(2, '0')}`).toBe(label)
})

test('cancelling inside 24 hours needs the late fee to be acknowledged', async ({ page }) => {
  const slot = londonSlot(5 * 3600000)
  const b = await booking({ date: slot.date, start_minutes: slot.start, created_at: new Date(Date.now() - 3 * 86400000).toISOString() })
  await signIn(page, `/account?booking=${b.id}`)
  await page.getByRole('button', { name: 'Cancel appointment', exact: true }).click()
  await expect(page.getByText(/a late fee of £85\.00 applies/)).toBeVisible()
  const confirm = page.getByRole('button', { name: 'Cancel appointment', exact: true }).last()
  await expect(confirm).toBeDisabled()
  await page.getByLabel(/I understand a late fee of £85\.00 will apply/).check()
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(page.getByText('Your appointment is cancelled.')).toBeVisible()
  await expect(page.getByText(/A late fee of £85\.00 is due/)).toBeVisible()
  const row = (await f.admin.from('bookings').select('booking_status,late_fee_status,cancellation_initiated_by').eq('id', b.id).single()).data
  expect(row).toMatchObject({ booking_status: 'cancelled', late_fee_status: 'due', cancellation_initiated_by: 'client' })
})

test('a started appointment explains that it cannot be changed online, and nothing technical is shown', async ({ page }) => {
  const slot = londonSlot(-2 * 3600000)
  const b = await booking({ date: slot.date, start_minutes: slot.start })
  await signIn(page, `/account?booking=${b.id}`)
  await expect(page.getByText('This appointment can no longer be changed online. Please contact Vad.').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel appointment', exact: true })).toHaveCount(0)
})

test('the account page fits a small phone without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  const b = await booking()
  await signIn(page)
  await expect(page.getByRole('button', { name: /Integration massage/ })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: /Integration massage/ }).click()
  await expect(page.getByRole('heading', { name: 'Confirmed' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/client-account-320.png', fullPage: true })
  expect(b.id).toBeTruthy()
})
