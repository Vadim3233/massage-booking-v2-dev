import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'

// More › Google Calendar. Google itself and the server's /api/google-calendar are stood in for: the page's own behaviour is what is checked.
let f
test.beforeEach(async () => {
  f = await adminFixture(6)
  await f.admin.from('calendar_connection').delete().eq('id', true)
})
test.afterEach(async () => {
  await f?.admin.rpc('calendar_forget_connection', { p_status: 'disconnected' })
  await f?.admin.from('calendar_connection').delete().eq('id', true)
  await f?.cleanup()
})

async function open(page, path = '/admin/settings/google-calendar') {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Google Calendar' })).toBeVisible()
}

test('not connected: what it does, and Connect sends the Admin to Google with the Admin\'s own sign-in', async ({ page }) => {
  await f.authorize()
  let asked = null
  await page.route('**/api/google-calendar?action=start', async route => { asked = route.request().headers().authorization; await route.fulfill({ json: { url: '/fake-google' } }) })
  await page.route('**/fake-google', route => route.fulfill({ contentType: 'text/html', body: '<title>Fake Google</title><h1>Fake Google</h1>' }))
  await page.goto('/admin/more')
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('region', { name: 'Every day' }).getByRole('link', { name: 'Google Calendar' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Google Calendar' })).toBeVisible()
  await expect(page.getByText(/the address \(with directions, even offline\).*Never the phone, price or notes\./)).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'test-results/google-calendar-not-connected.png' })
  await page.getByRole('button', { name: 'Connect Google Calendar' }).click()
  await expect(page.getByRole('heading', { name: 'Fake Google' })).toBeVisible()
  expect(asked).toMatch(/^Bearer .+/)
})

test('coming back from Google says how it went, once', async ({ page }) => {
  await f.authorize()
  await open(page, '/admin/settings/google-calendar?calendar=cancelled')
  await expect(page.getByRole('alert')).toHaveText('Google Calendar was not connected: the Google sign-in was cancelled.')
  await expect(page).toHaveURL(/\/admin\/settings\/google-calendar$/)
})

test('connected: the account, the last copy, Resync now, and Disconnect after a question', async ({ page }) => {
  await f.authorize()
  const saved = await f.admin.rpc('calendar_save_connection', { p_refresh_token: 'test-refresh', p_account_email: 'owner@example.test', p_calendar_id: 'test@group.calendar.google.com' })
  expect(saved.error).toBeNull()
  await f.admin.from('calendar_connection').update({ last_success_at: '2026-10-19T19:05:00Z' }).eq('id', true)
  await page.route('**/api/google-calendar?action=disconnect', async route => {
    expect(route.request().method()).toBe('POST')
    await f.admin.rpc('calendar_forget_connection', { p_status: 'disconnected' })
    await route.fulfill({ json: { disconnected: true } })
  })
  await open(page)
  await expect(page.locator('.admin-calendar-state')).toHaveText(/Connected$/)
  await expect(page.getByText('owner@example.test')).toBeVisible()
  await expect(page.getByText('19 Oct, 20:05')).toBeVisible()
  await page.screenshot({ path: 'test-results/google-calendar-connected.png' })
  await page.getByRole('button', { name: 'Resync now' }).click()
  await expect(page.getByRole('status')).toHaveText('Every booking will be copied again in the next few minutes.')
  const questions = []
  page.on('dialog', dialog => { questions.push(dialog.message()); dialog.accept() })
  await page.getByRole('button', { name: 'Disconnect' }).click()
  await expect(page.getByRole('status')).toHaveText('Disconnected. Bookings are no longer copied.')
  await expect(page.getByRole('button', { name: 'Connect Google Calendar' })).toBeVisible()
  expect(questions[0]).toMatch(/^Disconnect Google Calendar\?/)
})

test('needs reconnect: says why and offers Connect again', async ({ page }) => {
  await f.authorize()
  await f.admin.rpc('calendar_save_connection', { p_refresh_token: 'test-refresh', p_account_email: 'owner@example.test', p_calendar_id: 'test@group.calendar.google.com' })
  await f.admin.rpc('calendar_forget_connection', { p_status: 'needs_reconnect', p_error: 'Google asked you to connect again.' })
  await open(page)
  await expect(page.locator('.admin-calendar-state')).toHaveText(/Needs reconnect$/)
  await expect(page.getByText(/^Google asked you to connect again\. Until you do, new bookings are not copied\./)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect again' })).toBeVisible()
  await page.screenshot({ path: 'test-results/google-calendar-needs-reconnect.png' })
})

test('a signed-in client cannot see the calendar status', async () => {
  const { error } = await f.client.rpc('admin_calendar_status')
  expect(error?.message).toBe('Admin authorization required')
})
