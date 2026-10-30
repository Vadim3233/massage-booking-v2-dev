import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'

// Edit address on the booking sheet: the new address is saved and shown, and choosing an area with other fees shows the new price before saving.
// The fixture's first booking is confirmed, with cash approved, so its price may still change.
let f
test.beforeEach(async () => { f = await adminFixture(38) })
test.afterEach(async () => {
  if (f) await f.admin.from('event_outbox').delete().eq('aggregate_id', f.bookings[0].id)
  await f?.cleanup()
})

test('the Admin changes a booking\'s address, and sees a new area\'s price first', async ({ page }) => {
  await f.authorize()
  const id = f.bookings[0].id
  const mayfair = (await f.admin.from('service_areas').select('id,congestion_fee_gbp').eq('slug', 'mayfair').single()).data
  await page.goto(`/admin/bookings/${id}`)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Edit address' }).click()
  await page.getByRole('textbox', { name: 'Address', exact: true }).fill('1 Park Lane\nLondon W1K 1PN')
  await expect(page.getByRole('combobox', { name: 'Area' })).toBeEnabled()
  await page.getByRole('combobox', { name: 'Area' }).selectOption(mayfair.id)
  if (Number(mayfair.congestion_fee_gbp) > 0) await expect(page.getByText(/^New price £/)).toBeVisible()
  await page.getByRole('combobox', { name: 'Area' }).selectOption(f.ids.area)
  await page.getByLabel('Entry instructions (optional)').fill('Ring flat 2')
  await page.getByRole('button', { name: 'Save address' }).click()
  await expect(page.locator('.admin-details address').last()).toHaveText('1 Park Lane, London W1K 1PN')
  await expect(page.getByRole('button', { name: 'Edit address' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const saved = (await f.admin.from('bookings').select('address_snapshot,entry_instructions_snapshot').eq('id', id).single()).data
  expect(saved).toEqual({ address_snapshot: '1 Park Lane, London W1K 1PN', entry_instructions_snapshot: 'Ring flat 2' })
})
