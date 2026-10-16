import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { localConfig } from '../localSupabase.js'

// The page a client reaches from the link in a password reset email: /reset-password. Real local sign-in service, real links; the browser never has
// the service key. The local allowlist for where a link may return is the service's own port, so only the verified fragment is carried to the test
// site (as the Admin's reset tests do). Auth requests carry credentials, so no trace is kept.
test.use({ trace: 'off' })

let config, admin, email, userId
const OLD = 'Old-local-password-123'
const NEW = 'New-local-password-456'
const options = { auth: { persistSession: false, autoRefreshToken: false } }
test.beforeEach(async () => {
  config = localConfig()
  admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, options)
  email = `client-reset-${crypto.randomUUID()}@example.test`
  const { data, error } = await admin.auth.admin.createUser({ email, password: OLD, email_confirm: true, user_metadata: { first_name: 'Test', last_name: 'Client' } })
  if (error) throw error
  userId = data.user.id
})
test.afterEach(async () => { if (userId) await admin.auth.admin.deleteUser(userId) })

// A real recovery link, followed once by the test (as the person pressing it would), giving what the site is sent: the part after the #.
async function press(link) {
  const response = await fetch(link, { redirect: 'manual' })
  return new URL(response.headers.get('location')).hash
}
async function freshLink() {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email })
  if (error) throw error
  return data.properties.action_link
}
async function canSignInWith(password) {
  const { error } = await createClient(config.API_URL, config.ANON_KEY, options).auth.signInWithPassword({ email, password })
  return !error
}
// The request for a reset email is answered by the test, so no real email is sent (the local service allows two an hour); what is asked for is checked.
const answerRecover = (page, response = { status: 200, body: {} }) => page.route('**/auth/v1/recover?**', route => route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.body) }))
const heading = (page, name) => page.getByRole('heading', { name, level: 1 })
const password = page => page.getByLabel('New password', { exact: true })
const again = page => page.getByLabel('Type it again', { exact: true })

test('a fresh link opens the form at the top, and saving a new password signs the client in with it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/reset-password${await press(await freshLink())}`)
  await expect(heading(page, 'Choose a new password')).toBeVisible()
  // At the top of the page, in view, not somewhere far down it.
  expect((await heading(page, 'Choose a new password').boundingBox()).y).toBeLessThan(300)
  await expect(password(page)).toBeInViewport()
  await expect(page).toHaveTitle('Choose a new password · VadMassage')
  // The link's secret is out of the address once it has been used.
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('')
  // Too short, and not the same twice, are said in words before anything is sent.
  await password(page).fill('short')
  await again(page).fill('short')
  await page.getByRole('button', { name: 'Save new password' }).click()
  await expect(page.getByRole('alert')).toHaveText('Please choose a password of at least 8 characters.')
  await password(page).fill(NEW)
  await again(page).fill(`${NEW}x`)
  await page.getByRole('button', { name: 'Save new password' }).click()
  await expect(page.getByRole('alert')).toHaveText('The two passwords are not the same. Please type them again.')
  expect(await canSignInWith(NEW)).toBe(false)
  // The new password is saved, and the client is signed in.
  await again(page).fill(NEW)
  await page.getByRole('button', { name: 'Save new password' }).click()
  await expect(heading(page, 'Password saved')).toBeVisible()
  await expect(page.getByText('You are signed in.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Your bookings' })).toHaveAttribute('href', '/account')
  await expect(page.getByRole('link', { name: 'Book a massage' })).toHaveAttribute('href', '/')
  expect(await canSignInWith(NEW)).toBe(true)
  expect(await canSignInWith(OLD)).toBe(false)
  await page.getByRole('link', { name: 'Your bookings' }).click()
  await expect(page.getByRole('heading', { name: 'Your bookings', level: 1 })).toBeVisible()
})

test('the old password is refused as the new one, in plain words', async ({ page }) => {
  await page.goto(`/reset-password${await press(await freshLink())}`)
  await password(page).fill(OLD)
  await again(page).fill(OLD)
  await page.getByRole('button', { name: 'Save new password' }).click()
  await expect(page.getByRole('alert')).toHaveText('Please choose a password that is different from your old one.')
  expect(await canSignInWith(OLD)).toBe(true)
})

test('a link that was used already says so, and a new one can be asked for from the same page', async ({ page }) => {
  const link = await freshLink()
  await press(link)
  const second = await press(link)
  expect(second).toContain('error_code=otp_expired')
  await answerRecover(page)
  await page.goto(`/reset-password${second}`)
  await expect(heading(page, 'That link has expired')).toBeVisible()
  await expect(page.getByText(/works once, and stops working after a while/)).toBeVisible()
  await expect(password(page)).toHaveCount(0)
  const request = page.waitForRequest('**/auth/v1/recover?**')
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Send me a new link' }).click()
  const sent = await request
  expect(new URL(sent.url()).searchParams.get('redirect_to')).toBe('http://127.0.0.1:5174/reset-password')
  expect(sent.postDataJSON().email).toBe(email)
  // The same words whether or not there is an account for that email.
  await expect(page.getByRole('status').filter({ hasText: "I've sent a new link" })).toContainText('junk folder')
  await expect(page.getByRole('link', { name: 'Sign in to see your bookings' })).toHaveAttribute('href', '/account')
})

test('the page opened without a link asks for the email instead of showing a form', async ({ page }) => {
  await page.goto('/reset-password')
  await expect(heading(page, 'Reset your password')).toBeVisible()
  await expect(password(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Send me a new link' })).toBeVisible()
  await expect(page).toHaveTitle('Reset your password · VadMassage')
})

test('someone who is simply signed in cannot use the page to change a password: only the link can', async ({ page }) => {
  await page.goto('/account')
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(OLD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your bookings', level: 1 })).toBeVisible()
  await page.goto('/reset-password')
  await expect(heading(page, 'Reset your password')).toBeVisible()
  await expect(password(page)).toHaveCount(0)
})

test('Forgot password? on the booking page and on Your bookings both send the link to the reset page', async ({ page }) => {
  await answerRecover(page)
  for (const path of ['/', '/account']) {
    await page.goto(path)
    if (path === '/') await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByRole('button', { name: 'Forgot password?' }).click()
    await page.getByLabel('Email address').fill(email)
    const request = page.waitForRequest('**/auth/v1/recover?**')
    await page.getByRole('button', { name: 'Send reset link' }).click()
    const sent = await request
    expect(new URL(sent.url()).searchParams.get('redirect_to'), path).toBe('http://127.0.0.1:5174/reset-password')
    await expect(page.getByRole('alert').filter({ hasText: 'Check your email for the password reset link.' })).toContainText('junk folder')
  }
})

test('an older reset link, which opens the booking page or Your bookings, is sent on to the reset page', async ({ page }) => {
  for (const path of ['/?step=0', '/account']) {
    const hash = await press(await freshLink())
    await page.goto(`${path}${hash}`)
    await expect(page).toHaveURL(/\/reset-password/)
    await expect(heading(page, 'Choose a new password')).toBeVisible()
    await expect(password(page)).toBeVisible()
    // Out of the way for the next link.
    await page.context().clearCookies()
    await page.evaluate(() => { sessionStorage.clear(); localStorage.clear() })
  }
})

test('an email link that did not work says so on the booking page and on Your bookings, then tidies the address', async ({ page }) => {
  const problem = 'That email link has already been used or has expired.'
  await page.goto('/?step=0#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=')
  await expect(page.getByRole('alert').filter({ hasText: problem })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.location.pathname + window.location.search + window.location.hash)).toBe('/?step=0')
  await page.goto('/account#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')
  await expect(page.getByRole('alert').filter({ hasText: problem })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('')
  // A page opened the ordinary way says nothing of the kind.
  await page.goto('/account')
  await expect(page.getByRole('alert').filter({ hasText: problem })).toHaveCount(0)
})

test('the pages fit the smallest phone and can be used with the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto(`/reset-password${await press(await freshLink())}`)
  await expect(password(page)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  // The heading has the focus when the page opens, so a screen reader starts there; then the fields in order.
  await expect(heading(page, 'Choose a new password')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(password(page)).toBeFocused()
  await page.keyboard.type(NEW)
  await page.keyboard.press('Tab')
  await expect(again(page)).toBeFocused()
  await page.keyboard.type(NEW)
  await page.keyboard.press('Enter')
  await expect(heading(page, 'Password saved')).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.goto('/reset-password')
  await expect(page.getByRole('button', { name: 'Send me a new link' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('asking for a new link too often is said in plain words, never in the service\'s own', async ({ page }) => {
  await answerRecover(page, { status: 429, body: { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' } })
  await page.goto('/reset-password')
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Send me a new link' }).click()
  await expect(page.getByRole('alert')).toHaveText('That has been tried a few times. Please wait a minute and try again.')
  await expect(page.getByText(/rate limit/i)).toHaveCount(0)
})
