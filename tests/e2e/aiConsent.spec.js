import { test, expect } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { localConfig } from '../localSupabase.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'

// A client connecting their own AI assistant: the assistant sends them to /oauth/consent, they sign in and press Allow, and are sent back to it.
// Then /book-with-ai shows the address to paste and the assistant they allowed, with Disconnect.
const REDIRECT = 'http://127.0.0.1:9/callback'
const base64url = buffer => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
let config, admin, user, email, password

test.beforeEach(async () => {
  config = localConfig()
  admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  email = `e2e-ai-${crypto.randomUUID()}@example.test`
  password = `Test-only-${crypto.randomUUID()}`
  user = (await unwrap(admin.auth.admin.createUser({ email, password, email_confirm: true }))).user
})
test.afterEach(async () => { if (user) await admin.auth.admin.deleteUser(user.id) })

// Where the assistant would send the client: the consent page with a fresh authorization.
async function consentPath(name, redirect = REDIRECT) {
  const auth = `${config.API_URL}/auth/v1`
  const registered = await (await fetch(`${auth}/oauth/clients/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }) })).json()
  const challenge = base64url(createHash('sha256').update(base64url(randomBytes(32))).digest())
  const query = new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'e2e' })
  const location = new URL((await fetch(`${auth}/oauth/authorize?${query}`, { redirect: 'manual' })).headers.get('location'))
  return `${location.pathname}${location.search}`
}

test('a client signs in, allows their assistant, and is sent back to it; then sees it on Book with AI', async ({ page }) => {
  const name = `E2E assistant ${crypto.randomUUID().slice(0, 6)}`
  await page.goto(await consentPath(name))
  await expect(page.getByRole('heading', { name: 'Sign in to connect' })).toBeVisible()
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: `Allow ${name}?` })).toBeVisible()
  await expect(page.getByText(`as ${email}`)).toBeVisible()
  await expect(page.getByText('It always asks you before it books.')).toBeVisible()
  await expect(page.getByText('After you choose, you go back to the assistant on this computer.')).toBeVisible()
  // The assistant's own address is not running here: catch the redirect to it.
  let sentBack = ''
  await page.route('http://127.0.0.1:9/**', route => { sentBack = route.request().url(); return route.fulfill({ status: 200, body: 'back at the assistant' }) })
  await page.getByRole('button', { name: 'Allow' }).click()
  await expect.poll(() => sentBack).toMatch(/^http:\/\/127\.0\.0\.1:9\/callback\?code=.+&state=e2e/)

  await page.goto('/book-with-ai')
  await expect(page.getByRole('heading', { name: 'Book with your AI assistant' })).toBeVisible()
  await expect(page.locator('.ai-address code')).toHaveText('http://127.0.0.1:5174/mcp')
  const row = page.locator('.ai-grants li', { hasText: name })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'Disconnect' }).click()
  await expect(row).toHaveCount(0)
})

test('No thanks sends the client back to the assistant without allowing it', async ({ page }) => {
  const name = `E2E refused ${crypto.randomUUID().slice(0, 6)}`
  await page.goto(await consentPath(name))
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  let sentBack = ''
  await page.route('http://127.0.0.1:9/**', route => { sentBack = route.request().url(); return route.fulfill({ status: 200, body: 'back' }) })
  await page.getByRole('button', { name: 'No thanks' }).click()
  await expect.poll(() => sentBack).toMatch(/error=access_denied/)
})

test('an assistant that would send the sign-in anywhere else is refused, whatever it calls itself', async ({ page }) => {
  await page.goto(await consentPath('Claude', 'https://evil.example/callback'))
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: "This assistant can't connect" })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('evil.example')
  await expect(page.getByRole('button', { name: 'Allow' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'No thanks' })).toHaveCount(0)
})
