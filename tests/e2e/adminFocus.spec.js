import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'

let f
test.beforeEach(async () => { f = await adminFixture(5) })
test.afterEach(async () => { await f?.cleanup() })

async function login(page) {
  await page.goto('/admin/agenda')
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible()
}

// Most Admin pages load a moment after they are opened. While one loads, the page it replaces is still there, hidden, so a screen reader or a
// keyboard user who opens it must still be taken to its heading, not to the hidden one of the page they left.
test("opening a page that loads a moment late takes focus to that page's own heading", async ({ page }) => {
  await f.authorize()
  await login(page)
  const nav = page.getByRole('navigation', { name: 'Admin navigation' })
  await nav.getByRole('link', { name: /^Alerts/ }).click()
  await expect(page.getByRole('heading', { name: 'Alerts', level: 1 })).toBeFocused()
  await nav.getByRole('link', { name: 'Clients', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Clients', level: 1 })).toBeFocused()
  await nav.getByRole('link', { name: 'More', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'More', level: 1 })).toBeFocused()
  await page.getByRole('link', { name: 'Working hours and special days' }).click()
  await expect(page.getByRole('heading', { name: 'Working hours', level: 1 })).toBeFocused()
})

test('a page that is slow to arrive still gets its heading focused', async ({ page }) => {
  await f.authorize()
  await login(page)
  // Hold back the page's code for longer than the old half-second allowance.
  await page.route('**/src/admin/Clients.jsx*', async route => { await new Promise(resolve => setTimeout(resolve, 1500)); await route.continue() })
  await page.getByRole('navigation', { name: 'Admin navigation' }).getByRole('link', { name: 'Clients', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Clients', level: 1 })).toBeFocused({ timeout: 10000 })
})
