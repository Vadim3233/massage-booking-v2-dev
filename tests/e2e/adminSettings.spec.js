import { test, expect } from '@playwright/test'
import { paymentReviewFixture } from '../paymentReviewFixture.js'

let f
test.beforeEach(async () => { f = await paymentReviewFixture() })
test.afterEach(async () => {
  await f.admin.from('services').delete().like('name', 'E2E %')
  await f.admin.from('service_areas').delete().like('name', 'E2E %')
  await f.admin.from('enhancements').delete().like('name', 'E2E %')
  await f?.cleanup()
})

async function signIn(page, path) {
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
const visibleToClients = async (table, name) => (await f.publicClient.from(table).select('name').eq('active', true).eq('name', name)).data.length === 1

test('the More menu leads to each settings page', async ({ page }) => {
  await f.authorize()
  await signIn(page, '/admin/more')
  for (const [link, heading] of [['Services and prices', 'Services and prices'], ['Extras', 'Extras'], ['Areas and travel fees', 'Areas and travel fees'], ['Working hours and special days', 'Working hours']]) {
    await page.getByRole('link', { name: link, exact: true }).click()
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible()
    await page.getByRole('link', { name: '← More' }).click()
  }
})

test('a treatment can be added with prices, changed, hidden from clients and moved', async ({ page }) => {
  await f.authorize()
  await signIn(page, '/admin/settings/services')
  await expect(page.getByRole('heading', { name: 'Services and prices', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: '+ Add a treatment' }).click()
  const form = page.getByRole('region', { name: 'Add a treatment' })
  await form.getByLabel('Name', { exact: true }).fill('E2E Hot Stone')
  await form.getByLabel('Price for 60 minutes').fill('ninety')
  await expect(form.getByRole('alert')).toHaveText('Enter a price for 60 minutes, for example 90 or 90.50.')
  await expect(form.getByRole('button', { name: 'Add treatment' })).toBeDisabled()
  await form.getByLabel('Price for 60 minutes').fill('100')
  await form.getByLabel('Price for 90 minutes').fill('140.50')
  await form.getByLabel('120 minutes', { exact: true }).uncheck()
  await form.getByRole('button', { name: 'Add treatment' }).click()
  const item = page.locator('.admin-setting').filter({ hasText: 'E2E Hot Stone' })
  await expect(item).toContainText('60 min £100.00 · 90 min £140.50')
  expect(await visibleToClients('services', 'E2E Hot Stone')).toBe(true)
  await item.getByRole('button', { name: 'Change' }).click()
  const editing = page.locator('.admin-setting form')
  await editing.getByLabel('Price for 60 minutes').fill('105')
  await editing.getByRole('button', { name: 'Save changes' }).click()
  await expect(item).toContainText('60 min £105.00')
  await item.getByRole('button', { name: 'Hide' }).click()
  await expect(item).toContainText('Hidden from clients')
  expect(await visibleToClients('services', 'E2E Hot Stone')).toBe(false)
  await item.getByRole('button', { name: 'Show' }).click()
  await expect(item).toContainText('Shown to clients')
  const before = await page.locator('.admin-setting strong').allTextContents()
  const index = before.indexOf('E2E Hot Stone')
  await item.getByRole('button', { name: 'Move E2E Hot Stone up' }).click()
  await expect.poll(async () => (await page.locator('.admin-setting strong').allTextContents()).indexOf('E2E Hot Stone')).toBe(index - 1)
})

test('a shown treatment must offer at least one length', async ({ page }) => {
  await f.authorize()
  await signIn(page, '/admin/settings/services')
  await page.getByRole('button', { name: '+ Add a treatment' }).click()
  const form = page.getByRole('region', { name: 'Add a treatment' })
  await form.getByLabel('Name', { exact: true }).fill('E2E Nothing')
  for (const minutes of [60, 90, 120]) await form.getByLabel(`${minutes} minutes`, { exact: true }).uncheck()
  await expect(form.getByRole('alert')).toContainText('needs at least one length')
  await form.getByLabel('Show to clients').uncheck()
  await expect(form.getByRole('button', { name: 'Add treatment' })).toBeEnabled()
})

test('areas carry their fees and can be switched off for clients', async ({ page }) => {
  await f.authorize()
  await signIn(page, '/admin/settings/areas')
  await page.getByRole('button', { name: '+ Add an area' }).click()
  const form = page.getByRole('region', { name: 'Add an area' })
  await form.getByLabel('Area name').fill('E2E Richmond')
  await form.getByLabel('Travel surcharge (£)').fill('7.50')
  await form.getByLabel('Congestion charge (£)').fill('0')
  await form.getByRole('button', { name: 'Add area' }).click()
  const item = page.locator('.admin-setting').filter({ hasText: 'E2E Richmond' })
  await expect(item).toContainText('Travel £7.50 · Congestion none')
  expect(await visibleToClients('service_areas', 'E2E Richmond')).toBe(true)
  await item.getByRole('button', { name: 'Hide' }).click()
  await expect(item).toContainText('Not bookable')
  expect(await visibleToClients('service_areas', 'E2E Richmond')).toBe(false)
})

test('extras have a price and optional extra time, and the page fits a small phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await f.authorize()
  await signIn(page, '/admin/settings/extras')
  await page.getByRole('button', { name: '+ Add an extra' }).click()
  const form = page.getByRole('region', { name: 'Add an extra' })
  await form.getByLabel('Name', { exact: true }).fill('E2E Hot towel')
  await form.getByLabel('Price (£)').fill('5')
  await form.getByLabel('Extra minutes').fill('15')
  await form.getByRole('button', { name: 'Add extra' }).click()
  await expect(page.locator('.admin-setting').filter({ hasText: 'E2E Hot towel' })).toContainText('£5.00 · adds 15 min')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/admin-settings-extras-320.png' })
})

test('bank details are checked, saved, and shown back to the Admin', async ({ page }) => {
  const original = (await f.admin.from('business_settings').select('*').eq('key', 'bank_details')).data
  try {
    await f.authorize()
    await signIn(page, '/admin/settings/bank')
    await expect(page.getByRole('heading', { name: 'Bank transfer details', level: 1 })).toBeVisible()
    await page.getByLabel('Name on the account').fill('Vad Massage')
    await page.getByLabel('Sort code').fill('12-34')
    await page.getByLabel('Account number').fill('12345678')
    await expect(page.getByRole('alert')).toContainText('The sort code needs six digits')
    await expect(page.getByRole('button', { name: 'Save bank details' })).toBeDisabled()
    await page.getByLabel('Sort code').fill('123456')
    await page.getByLabel('A note for clients (optional)').fill('Please use the reference exactly')
    await page.getByRole('button', { name: 'Save bank details' }).click()
    await expect(page.getByText('Saved. Clients will see these details')).toBeVisible()
    expect((await f.admin.from('business_settings').select('value').eq('key', 'bank_details').single()).data.value).toMatchObject({ account_name: 'Vad Massage', sort_code: '12-34-56', account_number: '12345678' })
    await page.reload()
    await expect(page.getByLabel('Sort code')).toHaveValue('12-34-56')
    await expect(page.getByLabel('A note for clients (optional)')).toHaveValue('Please use the reference exactly')
  } finally {
    if (original.length) await f.admin.from('business_settings').upsert(original)
    else await f.admin.from('business_settings').delete().eq('key', 'bank_details')
  }
})
