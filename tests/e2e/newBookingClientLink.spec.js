import { test, expect } from '@playwright/test'
import { newBookingFixture } from '../newBookingFixture.js'

// The chosen client's name in New booking opens their page, with no discard question, and the page's back link returns to the booking as it was.
let f
test.beforeEach(async () => { f = await newBookingFixture(38) })
test.afterEach(async () => { await f?.cleanup() })

async function startWithClient(page) {
  await page.goto('/admin/agenda')
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: '+ New booking', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'New booking', exact: true })).toBeVisible()
  await page.getByLabel('Find a client').fill(f.recipient.email)
  await page.getByRole('button', { name: new RegExp(f.recipient.first_name) }).click()
  await expect(page.getByRole('radio', { name: /10 Saved Street/ })).toBeChecked()
  // Choices that are not the defaults, so a booking brought back can be seen to keep them.
  await page.getByRole('radio', { name: /20 Office Street/ }).check()
  await page.getByRole('combobox', { name: 'Service area', exact: true }).selectOption(f.ids.area)
  await page.getByRole('radio', { name: 'Integration massage', exact: true }).check()
  await page.getByRole('radio', { name: 'Cash — at appointment', exact: true }).check()
  await page.getByLabel('Appointment note (optional)').fill('Kept while away')
}
async function expectKept(page, name) {
  await expect(page.getByRole('heading', { name: 'New booking', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: new RegExp(name) })).toBeVisible()
  await expect(page.getByRole('radio', { name: /20 Office Street/ })).toBeChecked()
  await expect(page.getByRole('combobox', { name: 'Service area', exact: true })).toHaveValue(f.ids.area)
  await expect(page.getByRole('radio', { name: 'Integration massage', exact: true })).toBeChecked()
  await expect(page.getByRole('radio', { name: 'Cash — at appointment', exact: true })).toBeChecked()
  await expect(page.getByLabel('Appointment note (optional)')).toHaveValue('Kept while away')
}

test('the client\'s name opens their page with no question, and Back to the booking brings it back as it was, with what was changed there', async ({ page }) => {
  const dialogs = []
  page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss() })
  await page.setViewportSize({ width: 390, height: 844 })
  await startWithClient(page)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: 'test-results/new-booking-client-link.png' })
  await page.getByRole('link', { name: new RegExp(f.recipient.first_name) }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/clients/${f.recipient.id}$`))
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(f.recipient.first_name) })).toBeVisible()
  // Something changed on the client's page shows in the booking when she comes back.
  await page.getByRole('button', { name: 'Edit details' }).click()
  const form = page.getByRole('region', { name: 'Edit details' })
  await form.getByLabel('First name').fill('Renamed')
  await form.getByRole('button', { name: 'Save details' }).click()
  await expect(page.getByRole('heading', { level: 1, name: /^Renamed / })).toBeVisible()
  await page.screenshot({ path: 'test-results/new-booking-client-page.png' })
  await page.getByRole('button', { name: '← Back to the booking' }).click()
  await expectKept(page, '^Renamed ')
  await expect(page).toHaveURL(/\/admin\/bookings\/new/)
  expect(dialogs).toEqual([])
  // Cancel still goes back to where the booking was started, the Agenda.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(dialogs).toEqual(['Discard this unsaved booking?'])
})

test('the phone\'s back button returns to the booking too, and the client\'s page opened from Clients still goes back to Clients', async ({ page }) => {
  const dialogs = []
  page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.accept() })
  await startWithClient(page)
  await page.getByRole('link', { name: new RegExp(f.recipient.first_name) }).click()
  await expect(page.getByRole('button', { name: '← Back to the booking' })).toBeVisible()
  await page.goBack()
  await expectKept(page, f.recipient.first_name)
  expect(dialogs).toEqual([])
  // Discarding the booking, then opening the client's page the usual way.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(dialogs).toEqual(['Discard this unsaved booking?'])
  await expect(page.getByRole('heading', { name: 'New booking', exact: true })).toHaveCount(0)
  await page.goto(`/admin/clients/${f.recipient.id}`)
  await expect(page.getByRole('button', { name: '← Clients' })).toBeVisible()
  await expect(page.getByRole('button', { name: '← Back to the booking' })).toHaveCount(0)
})
