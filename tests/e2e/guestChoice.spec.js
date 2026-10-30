import { test, expect } from '@playwright/test'
import { chooseLength } from '../bookingSteps.js'
import { localFixture } from '../localSupabase.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'

let fixture
test.beforeEach(async () => { fixture = await localFixture(31) })
test.afterEach(async ({ page }) => {
  if (fixture && page.url().startsWith('http://127.0.0.1:5174')) fixture.trackKey(await page.evaluate(() => localStorage.getItem('vad-v2-hold-client-v1')))
  await fixture?.cleanup()
})

async function toChoice(page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Integration area/ }).click()
  await page.getByRole('button', { name: /Integration massage/ }).click()
  await chooseLength(page, 60)
  await page.getByLabel('Appointment date').fill(fixture.date)
  await page.getByRole('button', { name: '10:00', exact: true }).click()
  await page.getByRole('button', { name: 'Review booking', exact: true }).click()
  await page.getByRole('button', { name: 'Continue to your details' }).click()
}
const readDraft = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('vad-v2-booking-draft-v1')).draft)
const guestId = (page) => expect.poll(async () => (await readDraft(page)).ownerUserId, { message: 'the booking is tied to the guest' })

// Sign-up answers as the server gives them with "Confirm email" switched on (the local test server has it off).
const madeUpUser = (identities) => JSON.stringify({
  id: crypto.randomUUID(), aud: 'authenticated', role: '', email: 'someone@example.test', identities,
  user_metadata: {}, app_metadata: { provider: 'email' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
})

test('a guest can change their mind and sign in, keeping the choices, the held time and what was typed', async ({ page }) => {
  await toChoice(page)
  await page.getByRole('button', { name: 'Continue as guest' }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await expect(page.getByText("You're booking as a guest.")).toBeVisible()
  await page.getByLabel('First name', { exact: true }).fill('Typed')
  await page.getByLabel('Contact number', { exact: true }).fill('+44 7700 900555')
  await guestId(page).toBeTruthy()
  const guest = await readDraft(page)
  await fixture.trackUser(guest.ownerUserId)

  await page.getByRole('button', { name: 'Sign in or create an account instead' }).click()
  // The choices are back with signing in already open, and the booking so far is untouched.
  await expect(page.getByRole('heading', { name: 'Complete your booking' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue as guest' })).toBeVisible()
  const back = await readDraft(page)
  expect(back.hold.hold_id).toBe(guest.hold.hold_id)
  expect(back.sessions).toEqual(guest.sessions)
  expect(back.details.first_name).toBe('Typed')

  await page.getByLabel('Email address', { exact: true }).fill(fixture.email)
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await expect(page.getByText("You're booking as a guest.")).toHaveCount(0)
  await expect(page.getByLabel('First name', { exact: true })).toHaveValue('Typed')
  await expect(page.getByLabel('Contact number', { exact: true })).toHaveValue('+44 7700 900555')
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue(fixture.email)
  await expect.poll(async () => (await readDraft(page)).ownerUserId).not.toBe(guest.ownerUserId)
  expect((await readDraft(page)).hold.hold_id).toBe(guest.hold.hold_id)

  // The guest never became a client, and the booking goes on as the signed-in client's own.
  expect(await unwrap(fixture.admin.from('clients').select('id').eq('auth_user_id', guest.ownerUserId))).toHaveLength(0)
  await page.getByRole('textbox', { name: 'Address', exact: true }).fill('10 Switch Street, London, SW1A 1AA')
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await expect(page.getByRole('heading', { name: 'One last step' })).toBeVisible()
  // The page shows before the booking is saved, so wait for it (and so that clearing up never races it).
  await expect.poll(async () => (await unwrap(fixture.admin.from('bookings').select('id').eq('client_id', fixture.profile.client_id))).length).toBe(1)
})

test('after a refresh a guest still has the way out, and can go on as a guest again', async ({ page }) => {
  await toChoice(page)
  await page.getByRole('button', { name: 'Continue as guest' }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await guestId(page).toBeTruthy()
  const first = await readDraft(page)
  await fixture.trackUser(first.ownerUserId)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Sign in or create an account instead' }).click()
  await page.getByRole('button', { name: 'Continue as guest' }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await expect.poll(async () => (await readDraft(page)).ownerUserId).not.toBe(first.ownerUserId)
  const second = await readDraft(page)
  await fixture.trackUser(second.ownerUserId)
  expect(second.hold.hold_id).toBe(first.hold.hold_id)
})

test('a booking that is already made has no way back to the choices', async ({ page }) => {
  await toChoice(page)
  await page.getByRole('button', { name: 'Continue as guest' }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await guestId(page).toBeTruthy()
  const guestUserId = (await readDraft(page)).ownerUserId
  await page.getByLabel('First name', { exact: true }).fill('Guest')
  await page.getByLabel('Last name', { exact: true }).fill('Booker')
  await page.getByLabel('Email address', { exact: true }).fill(`guest-${crypto.randomUUID()}@example.test`)
  await page.getByLabel('Contact number', { exact: true }).fill('+44 7700 900321')
  await page.getByRole('textbox', { name: 'Address', exact: true }).fill('20 Guest Street, London, SW1A 2AA')
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await expect(page.getByRole('heading', { name: 'One last step' })).toBeVisible()
  // The page shows before the booking is saved: wait for the guest's profile and booking, so clearing up finds them and never races them.
  const guestClients = () => unwrap(fixture.admin.from('clients').select('id').eq('auth_user_id', guestUserId))
  await expect.poll(async () => (await guestClients()).length).toBe(1)
  await fixture.trackUser(guestUserId)
  const [guestClient] = await guestClients()
  await expect.poll(async () => (await unwrap(fixture.admin.from('bookings').select('id').eq('client_id', guestClient.id))).length).toBe(1)
  await expect(page.getByRole('button', { name: 'Sign in or create an account instead' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Continue as guest' })).toHaveCount(0)
})

// Only an account sign-up (with an email) is answered with a made-up user; the quiet guest session made when a time is held (ADR-086)
// signs up without one and goes to the real local server.
const fakeAccountSignUp = (body) => (route) => (route.request().postDataJSON()?.email
  ? route.fulfill({ status: 200, contentType: 'application/json', body }) : route.continue())

test('registering when the email has to be confirmed first keeps the booking waiting, and carries on from this page once it is', async ({ page }) => {
  let confirmed = false
  await page.route('**/auth/v1/signup*', fakeAccountSignUp(madeUpUser([{ provider: 'email' }])))
  await page.route('**/auth/v1/resend*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  // Until the link has been opened the sign-in is refused; afterwards the real local server answers.
  await page.route('**/auth/v1/token*', (route) => confirmed ? route.continue()
    : route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed' }) }))
  await toChoice(page)
  await page.getByRole('button', { name: 'Create an account', exact: true }).click()
  await page.getByLabel('First name', { exact: true }).fill('Wait')
  await page.getByLabel('Last name', { exact: true }).fill('Awhile')
  await page.getByLabel('Email address', { exact: true }).fill(fixture.email)
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('button', { name: 'Register', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: fixture.email })).toContainText('Your choices are saved here')

  await page.getByRole('button', { name: 'Send the email again' }).click()
  await expect(page.getByRole('alert').filter({ hasText: "I've sent it again" })).toBeVisible()
  // Pressing continue before the link has been opened says so, and nothing is lost.
  await page.getByRole('button', { name: "I've confirmed my email, continue" }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Please confirm your email first' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()

  confirmed = true
  await page.getByRole('button', { name: "I've confirmed my email, continue" }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  const draft = await readDraft(page)
  expect(draft.sessions.map((session) => session.duration_minutes)).toEqual([60])
  expect(draft.hold.hold_id).toBeTruthy()
})

test('someone who already has an account is told to sign in, with their email kept', async ({ page }) => {
  await page.route('**/auth/v1/signup*', fakeAccountSignUp(madeUpUser([])))
  await toChoice(page)
  await page.getByRole('button', { name: 'Create an account', exact: true }).click()
  await page.getByLabel('First name', { exact: true }).fill('Back')
  await page.getByLabel('Last name', { exact: true }).fill('Again')
  await page.getByLabel('Email address', { exact: true }).fill(fixture.email)
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('button', { name: 'Register', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'There is already an account with that email' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0)
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue(fixture.email)
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
})
