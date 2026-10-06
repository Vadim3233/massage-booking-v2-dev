import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { localConfig } from '../localSupabase.js'

// Auth requests contain credentials; do not retain browser traces for this suite.
test.use({ trace: 'off' })

let admin, email, userId, config
const oldPassword = 'Old-local-password-123'
const newPassword = 'New-local-password-456'
test.beforeEach(async () => {
  config = localConfig()
  admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  email = `recovery-${crypto.randomUUID()}@example.test`
  const { data, error } = await admin.auth.admin.createUser({ email, password: oldPassword, email_confirm: true })
  if (error) throw error
  userId = data.user.id
})
test.afterEach(async () => { if (userId) await admin.auth.admin.deleteUser(userId) })

async function recover(page) {
  // Real local GoTrue recovery link and verification; no browser service key.
  // Local redirect allowlist uses port 3000, so transfer only the verified
  // redirect fragment to the test server, without changing Auth configuration.
  const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email })
  if (error) throw error
  const response = await fetch(data.properties.action_link, { redirect: 'manual' })
  const target = new URL(response.headers.get('location'))
  await page.goto(`/admin/reset-password${target.hash}`)
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible()
  return data.properties.action_link
}
async function fill(page, confirmation = newPassword) {
  await page.getByLabel('New password', { exact: true }).fill(newPassword)
  await page.getByLabel('Confirm new password').fill(confirmation)
  await page.getByRole('button', { name: 'Change password', exact: true }).click()
}

test('forgot password requests current-origin redirect and gives neutral confirmation', async ({ page }) => {
  await page.goto('/admin')
  await page.getByRole('button', { name: 'Forgot password?' }).click()
  await page.getByLabel('Admin email').fill(email)
  const request = page.waitForRequest('**/auth/v1/recover?**')
  await page.getByRole('button', { name: 'Send reset link' }).click()
  const sent = await request
  expect(new URL(sent.url()).searchParams.get('redirect_to')).toBe('http://127.0.0.1:5174/admin/reset-password')
  expect(sent.postDataJSON().email).toBe(email)
  await expect(page.getByRole('status')).toHaveText('If an account exists for this email, a password reset link has been sent.')
})

test('unknown email gets the same neutral confirmation', async ({ page }) => {
  await page.goto('/admin?reset=request')
  await page.getByLabel('Admin email').fill(`missing-${crypto.randomUUID()}@example.test`)
  await page.getByRole('button', { name: 'Send reset link' }).click()
  await expect(page.getByRole('status')).toHaveText('If an account exists for this email, a password reset link has been sent.')
})

test('request network error is safe and retryable with duplicate submit disabled', async ({ page }) => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  await page.route('**/auth/v1/recover?**', async route => { await gate; await route.fulfill({ status: 500, json: { msg: 'private backend details' } }) })
  await page.goto('/admin?reset=request')
  await page.getByLabel('Admin email').fill(email)
  await page.getByRole('button', { name: 'Send reset link' }).click()
  await expect(page.getByRole('button', { name: 'Sending…' })).toBeDisabled()
  release()
  await expect(page.getByRole('alert')).toContainText('Could not send the reset request')
  await expect(page.getByText('private backend details')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Send reset link' })).toBeEnabled()
})

for (const suffix of ['', '#error=access_denied&error_code=otp_expired&error_description=Secret']) {
  test(`missing or expired recovery has request path: ${suffix ? 'expired' : 'missing'}`, async ({ page }) => {
    await page.goto(`/admin/reset-password${suffix}`)
    await expect(page.getByRole('heading', { name: 'Reset Admin password' })).toBeVisible()
    await expect(page.getByRole('alert')).toContainText('invalid or expired')
    await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0)
    await page.getByRole('link', { name: 'Request a new reset link' }).click()
    await expect(page.getByLabel('Admin email')).toBeVisible()
  })
}

test('real recovery survives reload, blocks mismatch, changes password, signs out and requires authorized login', async ({ page }) => {
  await recover(page)
  await page.reload()
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible()
  let updates = 0
  page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname === '/auth/v1/user') updates++ })
  await fill(page, 'Different-password-789')
  await expect(page.getByRole('alert')).toHaveText('Passwords do not match.')
  expect(updates).toBe(0)
  const logout = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/v1/logout')
  await fill(page)
  expect((await logout).ok()).toBe(true)
  await expect(page).toHaveURL(/\/admin\?password=changed$/)
  expect(updates).toBe(1)
  await expect(page.getByRole('status')).toContainText('Please sign in with your new password')
  await expect(page.getByRole('heading', { name: 'Admin sign in' })).toBeVisible()
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(newPassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('does not have Admin access')
  await page.goto('/admin/reset-password')
  await expect(page.getByRole('alert')).toContainText('recovery session is missing')
})

test('update error preserves retry and never exposes backend details', async ({ page }) => {
  await recover(page)
  await page.route('**/auth/v1/user', route => route.request().method() === 'PUT' ? route.fulfill({ status: 422, json: { msg: 'private backend details' } }) : route.continue())
  await fill(page)
  await expect(page.getByRole('alert')).toContainText('Could not change the password')
  await expect(page.getByText('private backend details')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Change password', exact: true })).toBeEnabled()
})

test('sign-out failure requires retry before returning to login', async ({ page }) => {
  await recover(page)
  await page.route('**/auth/v1/logout?**', route => route.fulfill({ status: 500, json: { msg: 'failure' } }))
  await fill(page)
  await expect(page.getByRole('alert')).toContainText('sign out failed')
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0)
  await page.unroute('**/auth/v1/logout?**')
  await page.getByRole('button', { name: 'Retry sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Admin sign in' })).toBeVisible()
})

test('a consumed real recovery link is rejected even with an existing recovery session', async ({ page }) => {
  const link = await recover(page)
  const response = await fetch(link, { redirect: 'manual' })
  const target = new URL(response.headers.get('location'))
  await page.goto(`/admin/reset-password${target.hash}`)
  await expect(page.getByRole('alert')).toContainText('invalid or expired')
  await expect(page.getByRole('link', { name: 'Request a new reset link' })).toBeVisible()
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0)
})

test('password minimum is enforced before any update', async ({ page }) => {
  await recover(page)
  let updates = 0
  page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname === '/auth/v1/user') updates++ })
  await page.getByLabel('New password', { exact: true }).fill('short')
  await page.getByLabel('Confirm new password').fill('short')
  await page.getByRole('button', { name: 'Change password', exact: true }).click()
  expect(await page.getByLabel('New password', { exact: true }).evaluate(input => input.validity.tooShort)).toBe(true)
  expect(updates).toBe(0)
})
