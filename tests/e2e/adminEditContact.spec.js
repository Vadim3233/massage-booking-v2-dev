import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'

// Edit contact details on the booking sheet: a wrong saved number is shown in red, the same strict phone check as the client page stops a
// wrong one being saved, a good one is saved to the client, and the client's name opens their page.
let f
test.beforeEach(async () => { f = await adminFixture(44) })
test.afterEach(async () => { await f?.cleanup() })

test('the Admin corrects a client\'s phone from the booking, and opens the client from its name', async ({ page }) => {
  await f.authorize()
  const booking = f.bookings[0]
  await f.admin.from('clients').update({ phone: '832496659' }).eq('id', booking.client_id)
  await page.goto(`/admin/bookings/${booking.id}`)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByText(/^This phone number looks wrong\./)).toBeVisible()
  await page.getByRole('button', { name: 'Edit contact details' }).click()
  const form = page.getByRole('region', { name: 'Edit contact details' })
  await form.getByLabel('Phone').fill('0770090012')
  await expect(form.getByRole('button', { name: 'Save details' })).toBeDisabled()
  await form.getByLabel('Phone').fill('07700 900123')
  await form.getByRole('button', { name: 'Save details' }).click()
  await expect(page.getByRole('link', { name: '07700 900123' })).toBeVisible()
  await expect(page.getByText(/^This phone number looks wrong\./)).toHaveCount(0)
  expect((await f.admin.from('clients').select('phone').eq('id', booking.client_id).single()).data.phone).toBe('07700 900123')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: /open client page$/ }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/clients/${booking.client_id}$`))
  await expect(page.getByRole('button', { name: 'Edit details' })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('button', { name: 'Edit contact details' })).toBeVisible()
})
