import { test, expect } from '@playwright/test'
import { paymentReviewFixture } from '../paymentReviewFixture.js'

let f
test.beforeEach(async () => { f = await paymentReviewFixture() })
test.afterEach(async () => { await f?.cleanup() })

async function signIn(page, path) {
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

test('the Admin can copy her booking link, and make one that starts part-way through', async ({ page, context, browser }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await f.authorize()
  await signIn(page, '/admin/more')
  await page.getByRole('link', { name: 'Your booking link', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your booking link', level: 1 })).toBeVisible()

  const link = page.getByLabel('The link', { exact: true })
  await expect(link).toHaveValue('http://127.0.0.1:5174/')
  await page.getByRole('button', { name: 'Copy link' }).click()
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('http://127.0.0.1:5174/')

  await page.getByText('A link that starts part-way through').click()
  await page.getByRole('combobox', { name: 'Area', exact: true }).selectOption({ label: 'Chelsea' })
  await page.getByRole('combobox', { name: 'Treatment', exact: true }).selectOption({ label: 'Massage' })
  await page.getByRole('combobox', { name: 'Length', exact: true }).selectOption('90')
  await expect(link).toHaveValue('http://127.0.0.1:5174/?area=chelsea&treatment=massage&minutes=90')
  await expect(page.getByRole('link', { name: 'Send on WhatsApp' })).toHaveAttribute('href', /^https:\/\/wa\.me\/\?text=Book%20a%20massage%20with%20me%20here%3A%20http/)

  // A client who opens the link starts at choosing a time, with those three already chosen.
  const client = await browser.newPage()
  await client.goto(await link.inputValue())
  await expect(client.getByRole('heading', { name: 'Choose date and time' })).toBeVisible()
  const draft = await client.evaluate(() => JSON.parse(sessionStorage.getItem('vad-v2-booking-draft-v1')).draft)
  expect(draft.sessions.map(session => session.duration_minutes)).toEqual([90])
  await client.close()
})

test('the link page fits a small phone and a treatment change clears the length', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await f.authorize()
  await signIn(page, '/admin/settings/link')
  await expect(page.getByRole('heading', { name: 'Your booking link', level: 1 })).toBeVisible()
  await page.getByText('A link that starts part-way through').click()
  await page.getByRole('combobox', { name: 'Area', exact: true }).selectOption({ label: 'Chelsea' })
  await page.getByRole('combobox', { name: 'Treatment', exact: true }).selectOption({ label: 'Massage' })
  await page.getByRole('combobox', { name: 'Length', exact: true }).selectOption('60')
  await expect(page.getByLabel('The link', { exact: true })).toHaveValue(/minutes=60$/)
  await page.getByRole('combobox', { name: 'Treatment', exact: true }).selectOption({ label: 'Body Exam' })
  await expect(page.getByLabel('The link', { exact: true })).toHaveValue('http://127.0.0.1:5174/?area=chelsea&treatment=body-exam')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
