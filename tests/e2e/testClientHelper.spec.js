import { test, expect } from '@playwright/test'
import { localFixture } from '../localSupabase.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'

let fixture
test.beforeEach(async () => { fixture = await localFixture(27) })
test.afterEach(async ({ page }) => {
  if (fixture && page.url().startsWith('http://127.0.0.1:5174')) fixture.trackKey(await page.evaluate(() => localStorage.getItem('vad-v2-hold-client-v1')))
  await fixture?.cleanup()
})

async function toAuth(page) {
  await page.goto('/?test=1')
  await page.getByRole('button', { name: /Integration area/ }).click()
  await page.getByRole('button', { name: /Integration massage/ }).click()
  await page.getByRole('button', { name: 'Add 60 minutes', exact: true }).click()
  await page.getByRole('button', { name: 'Choose date & time' }).click()
  await page.getByLabel('Appointment date').fill(fixture.date)
  await page.getByRole('button', { name: '10:00', exact: true }).click()
  await page.getByRole('button', { name: 'Review booking', exact: true }).click()
  await page.getByRole('button', { name: 'Continue to your details' }).click()
}

async function readDraft(page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem('vad-v2-booking-draft-v1')).draft)
}

test('New test client rotates the anonymous identity and preserves the booking hold', async ({ page }) => {
  await toAuth(page)
  await page.getByRole('button', { name: 'Continue as guest' }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New test client', exact: true })).toBeVisible()

  const before = await readDraft(page)
  expect(before.ownerUserId).toBeTruthy()
  await fixture.trackUser(before.ownerUserId)

  await page.getByRole('button', { name: 'New test client', exact: true }).click()
  await expect(page.getByLabel('First name', { exact: true })).toHaveValue('Test')
  await expect(page.getByLabel('Last name', { exact: true })).toHaveValue(/^Client [0-9a-f]{6}$/)
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue(/^vadtest\.[0-9a-f]{12}@example\.test$/)
  await expect(page.getByLabel('Contact number', { exact: true })).toHaveValue(/^07700\d{6}$/)

  const after = await readDraft(page)
  expect(after.ownerUserId).toBeTruthy()
  expect(after.ownerUserId).not.toBe(before.ownerUserId)
  expect(after.hold.hold_id).toBe(before.hold.hold_id)
  expect(after.hold.hold_token).toBe(before.hold.hold_token)
  expect(after.date).toBe(before.date)
  expect(after.start).toBe(before.start)
  expect(after.sessions).toEqual(before.sessions)

  const generatedEmail = await page.getByLabel('Email address', { exact: true }).inputValue()
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await expect(page.getByRole('heading', { name: 'One last step' })).toBeVisible()

  const clients = await unwrap(fixture.admin.from('clients').select('auth_user_id,normalized_email').eq('normalized_email', generatedEmail))
  expect(clients).toHaveLength(1)
  expect(clients[0].auth_user_id).toBe(after.ownerUserId)
  await fixture.trackUser(after.ownerUserId)
})

test('test-client identity rotation is never offered to a signed-in client', async ({ page }) => {
  await toAuth(page)
  await page.getByLabel('Email address', { exact: true }).fill(fixture.email)
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New test client', exact: true })).toHaveCount(0)
})
