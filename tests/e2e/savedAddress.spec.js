import { test, expect } from '@playwright/test'
import { chooseLength } from '../bookingSteps.js'
import { localFixture } from '../localSupabase.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'

let fixture
test.beforeEach(async () => { fixture = await localFixture(34) })
test.afterEach(async ({ page }) => {
  if (fixture && page.url().startsWith('http://127.0.0.1:5174')) fixture.trackKey(await page.evaluate(() => localStorage.getItem('vad-v2-hold-client-v1')))
  await fixture?.cleanup()
})

// The fixture's client is signed in at the top of the first page, then the booking goes as far as the details.
async function toDetails(page) {
  await page.goto('/')
  await page.getByRole('banner').getByRole('button', { name: 'Sign in' }).click()
  const panel = page.locator('#header-sign-in')
  await panel.getByLabel('Email address', { exact: true }).fill(fixture.email)
  await panel.getByLabel('Password', { exact: true }).fill(fixture.password)
  await panel.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('banner').getByRole('button', { name: 'Sign out' })).toBeVisible()
  await page.getByRole('button', { name: /Integration area/ }).click()
  await page.getByRole('button', { name: /Integration massage/ }).click()
  await chooseLength(page, 60)
  await page.getByLabel('Appointment date').fill(fixture.date)
  await page.getByRole('button', { name: '10:00', exact: true }).click()
  await page.getByRole('button', { name: 'Review booking', exact: true }).click()
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await expect(page.getByText('Loading your saved details…')).toHaveCount(0)
}
const HOME = '12 Edith Road, West Drayton, London, UB7 7LG'
const addAddress = (changes = {}) => unwrap(fixture.admin.from('client_addresses').insert({
  client_id: fixture.profile.client_id, label: 'Home', address: HOME, is_default: false, ...changes,
}).select().single())
const savedAddress = (page) => page.getByLabel('Saved address')
const address = (page) => page.getByRole('textbox', { name: 'Address', exact: true })
const bookings = () => unwrap(fixture.admin.from('bookings').select('saved_address_id,address_snapshot').eq('client_id', fixture.profile.client_id))

test('the default address is chosen as soon as the details open, so a returning client only presses Continue', async ({ page }) => {
  const home = await addAddress({ is_default: true })
  await addAddress({ label: 'Saved address', address: '5 Work Street, London, EC1A 1BB' })
  await toDetails(page)
  await expect(savedAddress(page)).toHaveValue(home.id)
  await expect(address(page)).toHaveValue(HOME)
  await expect(address(page)).toBeDisabled()
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await expect(page.getByRole('heading', { name: 'One last step' })).toBeVisible()
  // The booking is made for that address. The page shows before the booking is saved, so wait for it.
  await expect.poll(async () => (await bookings())[0]?.saved_address_id).toBe(home.id)
  expect((await bookings())[0]).toMatchObject({ address_snapshot: HOME })
})

test('choosing "Enter an address" empties the boxes, so none of the saved address is left in a new one', async ({ page }) => {
  await addAddress({ is_default: true })
  await toDetails(page)
  await expect(address(page)).toHaveValue(HOME)
  await savedAddress(page).selectOption({ label: 'Enter an address' })
  await expect(address(page)).toBeEnabled()
  await expect(address(page)).toHaveValue('')
  await address(page).fill('7 New Road, London, SW1A 2AA')
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await expect(page.getByRole('heading', { name: 'One last step' })).toBeVisible()
  await expect.poll(async () => (await bookings())[0]?.address_snapshot).toBe('7 New Road, London, SW1A 2AA')
})

test('a client with only one saved address is offered it even when it is not marked as the default', async ({ page }) => {
  const only = await addAddress({ is_default: false })
  await toDetails(page)
  await expect(savedAddress(page)).toHaveValue(only.id)
  await expect(address(page)).toHaveValue(HOME)
})

test('with several saved addresses and none marked, nothing is chosen for the client', async ({ page }) => {
  await addAddress({ label: 'Saved address' })
  await addAddress({ label: 'Saved address', address: '9 Other Road, London, N1 9GU' })
  await toDetails(page)
  await expect(savedAddress(page)).toHaveValue('')
  await expect(address(page)).toHaveValue('')
  await expect(address(page)).toBeEnabled()
})

test('a client with no saved address sees no choice, and the boxes are empty as before', async ({ page }) => {
  await toDetails(page)
  await expect(savedAddress(page)).toHaveCount(0)
  await expect(address(page)).toHaveValue('')
  await expect(address(page)).toBeEnabled()
})

test('going back and forward keeps the address typed instead of putting the default back', async ({ page }) => {
  await addAddress({ is_default: true })
  await toDetails(page)
  await savedAddress(page).selectOption({ label: 'Enter an address' })
  await address(page).fill('7 New Road, London, SW1A 2AA')
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('button', { name: 'Continue to your details' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await expect(page.getByText('Loading your saved details…')).toHaveCount(0)
  await expect(address(page)).toHaveValue('7 New Road, London, SW1A 2AA')
  await expect(savedAddress(page)).toHaveValue('')
})
