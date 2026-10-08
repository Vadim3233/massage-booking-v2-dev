import { test, expect } from '@playwright/test'
import { paymentReviewFixture } from '../paymentReviewFixture.js'

let f
test.beforeEach(async () => {
  f = await paymentReviewFixture()
  await f.admin.from('business_settings').delete().in('key', ['welcome_text', 'about_text'])
})
test.afterEach(async () => {
  await f.admin.from('business_settings').delete().in('key', ['welcome_text', 'about_text'])
  await f?.cleanup()
})

async function signIn(page, path) {
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

test('the booking page opens with a warm standard welcome, how it works, and the free change window', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'A massage that comes to you', level: 1 })).toBeVisible()
  await expect(page.getByText("Hello, I'm Vad. I come to you")).toBeVisible()
  await expect(page.getByRole('list', { name: 'How booking works' }).getByRole('listitem')).toHaveCount(3)
  await expect(page.getByText(/Free to change or cancel more than 24 hours/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Choose your area', level: 2 })).toBeVisible()
  await expect(page.getByText('A little about me')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('the Admin writes her own welcome and about text, and visitors see them straight away', async ({ page, browser }) => {
  await f.authorize()
  await signIn(page, '/admin/more')
  await page.getByRole('link', { name: 'Welcome message', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Welcome message', level: 1 })).toBeVisible()
  await page.getByRole('textbox', { name: /^Welcome/ }).fill('Welcome to my practice.\n\nTake a moment to choose what suits you.')
  await page.getByRole('textbox', { name: /A little about me/ }).fill('I trained for two years and I am happy to answer questions.')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved. It shows at the top of the booking page now.')).toBeVisible()

  const visitor = await browser.newPage()
  await visitor.goto('/')
  await expect(visitor.getByText('Welcome to my practice.')).toBeVisible()
  await expect(visitor.getByText('Take a moment to choose what suits you.')).toBeVisible()
  await expect(visitor.getByText("Hello, I'm Vad. I come to you")).toHaveCount(0)
  await visitor.getByText('A little about me').click()
  await expect(visitor.getByText('I trained for two years')).toBeVisible()
  await visitor.close()

  await page.getByRole('textbox', { name: /^Welcome/ }).fill('')
  await page.getByRole('textbox', { name: /A little about me/ }).fill('')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved. It shows at the top of the booking page now.')).toBeVisible()
  expect((await f.admin.from('business_settings').select('key').in('key', ['welcome_text', 'about_text'])).data).toEqual([])
})

test('a welcome that is too long is stopped with a plain sentence', async ({ page }) => {
  await f.authorize()
  await signIn(page, '/admin/settings/welcome')
  await page.getByRole('textbox', { name: /^Welcome/ }).fill('x'.repeat(520))
  await expect(page.getByRole('alert')).toHaveText('The welcome can be up to 500 characters.')
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
})
