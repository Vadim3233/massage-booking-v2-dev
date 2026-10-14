import { test, expect } from '@playwright/test'
import { localFixture } from '../localSupabase.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'

let fixture
test.beforeEach(async () => { fixture = await localFixture(32) })
test.afterEach(async ({ page }) => {
  if (fixture && page.url().startsWith('http://127.0.0.1:5174')) fixture.trackKey(await page.evaluate(() => localStorage.getItem('vad-v2-hold-client-v1')))
  await fixture?.cleanup()
})

async function toReview(page) {
  await page.getByRole('button', { name: /Integration area/ }).click()
  await page.getByRole('button', { name: /Integration massage/ }).click()
  await page.getByRole('button', { name: /^60 minutes/ }).click()
  await page.getByLabel('Appointment date').fill(fixture.date)
  await page.getByRole('button', { name: '10:00', exact: true }).click()
  await page.getByRole('button', { name: 'Review booking', exact: true }).click()
}
const readDraft = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('vad-v2-booking-draft-v1')).draft)
const top = (page) => page.getByRole('banner')

// With the panel already open: fill it in as the fixture client and press its own Sign in.
async function submitSignIn(page) {
  const panel = page.locator('#header-sign-in')
  await expect(panel.getByRole('heading', { name: 'Sign in', level: 2 })).toBeVisible()
  await panel.getByLabel('Email address', { exact: true }).fill(fixture.email)
  await panel.getByLabel('Password', { exact: true }).fill(fixture.password)
  await panel.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(top(page).getByRole('button', { name: 'Sign out' })).toBeVisible()
  await expect(panel).toHaveCount(0)
}
async function signInAtTheTop(page) {
  await top(page).getByRole('button', { name: 'Sign in' }).click()
  await submitSignIn(page)
}

test('the first page has Sign in at the top, and signing in there means the guest question never comes up', async ({ page }) => {
  await page.goto('/')
  await expect(top(page).getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(top(page).getByRole('link', { name: 'Your bookings' })).toBeVisible()
  await top(page).getByRole('button', { name: 'Sign in' }).click()
  await expect(top(page).getByRole('button', { name: 'Sign in' })).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#header-sign-in').getByRole('heading', { name: 'Sign in', level: 2 })).toBeFocused()
  await submitSignIn(page)
  await expect(top(page).getByRole('button', { name: 'Sign in' })).toHaveCount(0)

  // Carrying on, the details come straight up as the signed-in client: there is no guest or sign-in question.
  await toReview(page)
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue as guest' })).toHaveCount(0)
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue(fixture.email)
})

test('a guest can sign in from the top too, and the booking goes on as the signed-in client', async ({ page }) => {
  await page.goto('/')
  await toReview(page)
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await page.getByRole('button', { name: 'Continue as guest' }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await page.getByLabel('First name', { exact: true }).fill('Typed')
  await expect.poll(async () => (await readDraft(page)).ownerUserId).toBeTruthy()
  const guest = await readDraft(page)
  await fixture.trackUser(guest.ownerUserId)

  await signInAtTheTop(page)
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue(fixture.email)
  await expect(page.getByLabel('First name', { exact: true })).toHaveValue('Typed')
  await expect.poll(async () => (await readDraft(page)).ownerUserId).not.toBe(guest.ownerUserId)
  expect((await readDraft(page)).hold.hold_id).toBe(guest.hold.hold_id)
})

test('once a booking is made the top of the page offers neither signing in nor out', async ({ page }) => {
  await page.goto('/')
  await toReview(page)
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await page.getByRole('button', { name: 'Continue as guest' }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await expect.poll(async () => (await readDraft(page)).ownerUserId).toBeTruthy()
  const guestUserId = (await readDraft(page)).ownerUserId
  await page.getByLabel('First name', { exact: true }).fill('Guest')
  await page.getByLabel('Last name', { exact: true }).fill('Booker')
  await page.getByLabel('Email address', { exact: true }).fill(`guest-${crypto.randomUUID()}@example.test`)
  await page.getByLabel('Contact number', { exact: true }).fill('+44 7700 900321')
  await page.getByLabel('Street address', { exact: true }).fill('20 Guest Street')
  await page.getByLabel('Postcode', { exact: true }).fill('SW1A 2AA')
  await expect(top(page).getByRole('button', { name: 'Sign in' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await expect(page.getByRole('heading', { name: 'One last step' })).toBeVisible()
  // The page shows before the booking is saved: wait for the guest's profile and booking, so clearing up finds them and never races them.
  const guestClients = () => unwrap(fixture.admin.from('clients').select('id').eq('auth_user_id', guestUserId))
  await expect.poll(async () => (await guestClients()).length).toBe(1)
  await fixture.trackUser(guestUserId)
  const [guestClient] = await guestClients()
  await expect.poll(async () => (await unwrap(fixture.admin.from('bookings').select('id').eq('client_id', guestClient.id))).length).toBe(1)
  await expect(top(page).getByRole('button', { name: 'Sign in' })).toHaveCount(0)
  await expect(top(page).getByRole('button', { name: 'Sign out' })).toHaveCount(0)
  await expect(top(page).getByRole('link', { name: 'Your bookings' })).toBeVisible()
})

test('signing out from the top puts the page back, and the choice comes back on the details screen', async ({ page }) => {
  await page.goto('/')
  await signInAtTheTop(page)
  await top(page).getByRole('button', { name: 'Sign out' }).click()
  await expect(top(page).getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(top(page).getByRole('button', { name: 'Sign out' })).toHaveCount(0)
  await toReview(page)
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await expect(page.getByRole('button', { name: 'Continue as guest' })).toBeVisible()
  // The details screen has its own sign-in, so the top of the page does not offer a second one beside it.
  await expect(top(page).getByRole('button', { name: 'Sign in' })).toHaveCount(0)
})

test('an account can be created from the top, and signs straight in', async ({ page }) => {
  await page.goto('/')
  await top(page).getByRole('button', { name: 'Sign in' }).click()
  const panel = page.locator('#header-sign-in')
  await panel.getByRole('button', { name: 'Create an account', exact: true }).click()
  await expect(panel.getByRole('heading', { name: 'Create your account', level: 2 })).toBeVisible()
  const email = `top-signup-${crypto.randomUUID()}@example.test`
  await panel.getByLabel('First name', { exact: true }).fill('Top')
  await panel.getByLabel('Last name', { exact: true }).fill('Register')
  await panel.getByLabel('Email address', { exact: true }).fill(email)
  await panel.getByLabel('Password', { exact: true }).fill(fixture.password)
  await panel.getByRole('button', { name: 'Register', exact: true }).click()
  await expect(top(page).getByRole('button', { name: 'Sign out' })).toBeVisible()
  const { data } = await fixture.admin.auth.admin.listUsers({ perPage: 1000 })
  await fixture.trackUser(data.users.find((user) => user.email === email).id)
})

test('the top of the page fits a 320px phone, with and without the sign-in panel open', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('/')
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  await expect(top(page).getByRole('button', { name: 'Sign in' })).toBeVisible()
  expect(await fits()).toBe(true)
  await top(page).getByRole('button', { name: 'Sign in' }).click()
  await expect(page.locator('#header-sign-in')).toBeVisible()
  expect(await fits()).toBe(true)
  await top(page).getByRole('button', { name: 'Sign in' }).click()
  await expect(page.locator('#header-sign-in')).toHaveCount(0)
})
