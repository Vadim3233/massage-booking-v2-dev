import { test, expect } from '@playwright/test'
import { localFixture } from '../localSupabase.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'

let fixture
test.beforeEach(async () => { fixture = await localFixture(36) })
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
// The fixture's client is signed in at the top of the first page, then the booking goes as far as the details.
async function toDetails(page) {
  await page.goto('/')
  await page.getByRole('banner').getByRole('button', { name: 'Sign in' }).click()
  const panel = page.locator('#header-sign-in')
  await panel.getByLabel('Email address', { exact: true }).fill(fixture.email)
  await panel.getByLabel('Password', { exact: true }).fill(fixture.password)
  await panel.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('banner').getByRole('button', { name: 'Sign out' })).toBeVisible()
  await toReview(page)
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await expect(page.getByText('Loading your saved details…')).toHaveCount(0)
}
const addAddress = () => unwrap(fixture.admin.from('client_addresses').insert({
  client_id: fixture.profile.client_id, label: 'Home', address_line_1: '12 Edith Road', address_line_2: 'West Drayton', city: 'London', postcode: 'UB7 7LG', is_default: true,
}).select().single())
const setPhone = (phone) => unwrap(fixture.admin.from('clients').update({ phone }).eq('id', fixture.profile.client_id))
const savedPhone = async () => (await unwrap(fixture.admin.from('clients').select('phone').eq('id', fixture.profile.client_id).single())).phone
const bookings = () => unwrap(fixture.admin.from('bookings').select('id').eq('client_id', fixture.profile.client_id))
const firstName = (page) => page.getByLabel('First name', { exact: true })
const lastName = (page) => page.getByLabel('Last name', { exact: true })
const phone = (page) => page.getByLabel('Contact number', { exact: true })
const email = (page) => page.getByLabel('Email address', { exact: true })
const editButton = (page) => page.getByRole('button', { name: 'Edit my details' })
// The page shows before the booking is saved, so wait for it, and clearing up finds it and never races it.
async function continueToPayment(page) {
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await expect(page.getByRole('heading', { name: 'One last step' })).toBeVisible()
  await expect.poll(async () => (await bookings()).length).toBe(1)
}

test("a returning client's name, phone and email are locked, and Continue works without touching them", async ({ page }) => {
  await addAddress()
  await toDetails(page)
  for (const box of [firstName(page), lastName(page), phone(page), email(page)]) await expect(box).not.toBeEditable()
  await expect(firstName(page)).toHaveValue('Test')
  await expect(lastName(page)).toHaveValue('Client')
  await expect(phone(page)).toHaveValue('+447700900001')
  await expect(editButton(page)).toBeVisible()
  await continueToPayment(page)
  expect(await savedPhone()).toBe('+447700900001')
})

test('"Edit my details" opens the name and phone but never the email, and a change is saved to the account', async ({ page }) => {
  await addAddress()
  await toDetails(page)
  await editButton(page).click()
  await expect(firstName(page)).toBeEditable()
  await expect(firstName(page)).toBeFocused()
  await expect(lastName(page)).toBeEditable()
  await expect(phone(page)).toBeEditable()
  await expect(email(page)).not.toBeEditable()
  await expect(editButton(page)).toHaveCount(0)
  await expect(page.getByText('You can change your name and phone now.')).toBeVisible()
  await phone(page).fill('+44 7700 900777')
  await continueToPayment(page)
  expect(await savedPhone()).toBe('+44 7700 900777')
})

test('details that are not all saved are open from the start, with no button', async ({ page }) => {
  await addAddress()
  await setPhone(null)
  await toDetails(page)
  await expect(editButton(page)).toHaveCount(0)
  await expect(firstName(page)).toBeEditable()
  await expect(phone(page)).toBeEditable()
  await expect(phone(page)).toHaveValue('')
  await expect(email(page)).not.toBeEditable()
  await phone(page).fill('+44 7700 900555')
  await continueToPayment(page)
  expect(await savedPhone()).toBe('+44 7700 900555')
})

test('a saved number that cannot be right opens the lock when Continue finds it', async ({ page }) => {
  await addAddress()
  await setPhone('12345')
  await toDetails(page)
  await expect(phone(page)).not.toBeEditable()
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await expect(page.getByRole('alert').filter({ hasText: "That number doesn't look right" })).toBeVisible()
  await expect(phone(page)).toBeEditable()
  await expect(phone(page)).toBeFocused()
  await expect(editButton(page)).toHaveCount(0)
  await phone(page).fill('+44 7700 900666')
  await continueToPayment(page)
  expect(await savedPhone()).toBe('+44 7700 900666')
})

test('going back and forward locks the details again, with a changed number kept', async ({ page }) => {
  await addAddress()
  await toDetails(page)
  await editButton(page).click()
  await phone(page).fill('+44 7700 900888')
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('button', { name: 'Continue to your details' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await expect(page.getByText('Loading your saved details…')).toHaveCount(0)
  await expect(phone(page)).not.toBeEditable()
  await expect(phone(page)).toHaveValue('+44 7700 900888')
  await expect(editButton(page)).toBeVisible()
  expect(await savedPhone()).toBe('+447700900001')
})

test('a guest has open boxes and no lock', async ({ page }) => {
  await page.goto('/')
  await toReview(page)
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await page.getByRole('button', { name: 'Continue as guest' }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => JSON.parse(sessionStorage.getItem('vad-v2-booking-draft-v1')).draft)).ownerUserId).toBeTruthy()
  await fixture.trackUser((await page.evaluate(() => JSON.parse(sessionStorage.getItem('vad-v2-booking-draft-v1')).draft)).ownerUserId)
  await expect(editButton(page)).toHaveCount(0)
  await expect(firstName(page)).toBeEditable()
  await expect(phone(page)).toBeEditable()
  await expect(email(page)).toBeEditable()
})
