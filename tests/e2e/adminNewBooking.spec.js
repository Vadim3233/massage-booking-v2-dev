import { test, expect } from '@playwright/test'
import { newBookingFixture } from '../newBookingFixture.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'
import { today } from '../../src/admin/calendarPresentation.js'

let f
test.beforeEach(async () => { f = await newBookingFixture(37) })
test.afterEach(async () => { await f?.cleanup() })

async function login(page, route = '/admin') {
  await page.goto(route)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: '+ New booking', exact: true })).toBeVisible()
}
async function start(page, agenda = false) {
  await login(page, agenda ? '/admin/agenda' : '/admin/day')
  if (!agenda) await page.getByLabel('Calendar date', { exact: true }).fill(f.date)
  await page.getByRole('button', { name: '+ New booking', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'New booking', exact: true })).toBeVisible()
}
async function selectClient(page) {
  await page.getByLabel('Find a client').fill(f.recipient.email)
  await page.getByRole('button', { name: new RegExp(f.recipient.first_name) }).click()
  await expect(page.getByRole('radio', { name: /10 Saved Street/ })).toBeChecked()
  await page.getByRole('combobox', { name: 'Service area', exact: true }).selectOption(f.ids.area)
}
async function next(page) { await page.getByRole('button', { name: 'Continue', exact: true }).click() }
async function treatment(page, sessions = 1) {
  await next(page)
  await page.getByRole('combobox', { name: 'Treatment', exact: true }).selectOption(f.ids.service)
  for (let i = 1; i <= sessions; i++) {
    if (i > 1) await page.getByRole('button', { name: '+ Add session', exact: true }).click()
    await page.getByLabel(`Recipient name ${i}`, { exact: true }).fill(`Recipient ${i}`)
  }
  await page.locator('fieldset.anb-session').first().locator('summary').filter({ hasText: /^Focus(?! on)/ }).click()
  await page.getByRole('button', { name: 'Integration focus', exact: true }).first().click()
  await page.getByRole('checkbox', { name: /Integration enhancement/ }).check()
}
async function timeAndPayment(page) {
  await next(page)
  await expect(page.getByLabel('Appointment date')).toHaveValue(f.date)
  await page.getByRole('group', { name: 'Available times' }).getByRole('button').first().click()
  await next(page)
}

test('Day date, saved address, sessions, authoritative quote, four payments and exactly-once success', async ({ page }) => {
  await start(page)
  await selectClient(page)
  await treatment(page, 2)
  await timeAndPayment(page)
  for (const name of ['Bank transfer — payment pending', 'Bank transfer — already received', 'Cash — at appointment', 'Cash — already received']) {
    await page.getByRole('radio', { name, exact: true }).check()
    await expect(page.getByRole('radio', { name, exact: true })).toBeChecked()
  }
  await page.getByLabel('Appointment note (optional)').fill('Admin E2E appointment note')
  await next(page)
  await expect(page.getByText('Use side entrance', { exact: true })).toBeVisible()
  await expect(page.getByText('£200.00', { exact: true })).toBeVisible()
  await expect(page.getByText('Congestion fee', { exact: true })).toBeVisible()
  let creates = 0
  page.on('request', request => { if (request.url().includes('/rpc/admin_create_booking')) creates++ })
  await page.getByRole('button', { name: 'Create booking', exact: true }).evaluate(button => { button.click(); button.click() })
  await expect(page.getByRole('dialog')).toContainText('Admin E2E appointment note')
  expect(creates).toBe(1)
  const rows = await unwrap(f.admin.from('bookings').select('id,booking_payments(*)').eq('client_id', f.recipient.id))
  expect(rows).toHaveLength(1)
  expect(rows[0].booking_payments).toMatchObject({ method: 'cash', status: 'paid' })
  expect(await page.evaluate(id => sessionStorage.getItem(`admin-new-booking:v1:${id}`), f.user.id)).toBeNull()
  await page.getByRole('button', { name: 'Close details', exact: true }).click()
  await expect(page.getByLabel('Calendar date')).toHaveValue(f.date)
  await expect(page.locator('.admin-card')).toHaveCount(1)
})

test('Agenda entry defaults today, preserves one-off draft through browser history and confirms discard', async ({ page }) => {
  await start(page, true)
  await selectClient(page)
  await page.getByRole('radio', { name: 'One-off booking address', exact: true }).check()
  await page.getByLabel('Address line 1', { exact: true }).fill('99 Temporary Road')
  await page.getByLabel('City', { exact: true }).fill('London')
  await page.getByLabel('Postcode', { exact: true }).fill('SW1A 1AA')
  await treatment(page)
  await next(page)
  await expect(page.getByLabel('Appointment date')).toHaveValue(today())
  await page.goBack()
  await expect(page.getByLabel('Recipient name 1')).toHaveValue('Recipient 1')
  await page.goBack()
  await expect(page.getByLabel('Address line 1', { exact: true })).toHaveValue('99 Temporary Road')
  await page.goForward()
  await expect(page.getByRole('combobox', { name: 'Treatment', exact: true })).toHaveValue(f.ids.service)
  page.once('dialog', dialog => dialog.dismiss())
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'New booking', exact: true })).toBeVisible()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/agenda$/)
  expect(await unwrap(f.admin.from('client_addresses').select('address_line_1').eq('client_id', f.recipient.id))).toHaveLength(2)
})

test('inline client duplicate is actionable and new canonical client saves a default address', async ({ page }) => {
  await start(page)
  await page.getByRole('button', { name: '+ Add new client', exact: true }).click()
  await page.getByLabel('First name', { exact: true }).fill('Inline E2E')
  await page.getByLabel('Email', { exact: true }).fill(f.recipient.email)
  await page.getByLabel('Address line 1', { exact: true }).fill('33 Inline Road')
  await page.getByLabel('City', { exact: true }).fill('London')
  await page.getByLabel('Postcode', { exact: true }).fill('SW1A 1AA')
  await page.getByRole('button', { name: 'Save client', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(/existing|already|duplicate/i)
  const email = `new-e2e-${crypto.randomUUID()}@example.test`
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByRole('button', { name: 'Save client', exact: true }).click()
  await expect(page.getByRole('radio', { name: /33 Inline Road/ })).toBeChecked()
  const client = await unwrap(f.admin.from('clients').select('id,auth_user_id').eq('email', email).single())
  f.trackRecipient(client.id)
  expect(client.auth_user_id).toBeNull()
})

test('stale selected slot is rejected and no booking is created', async ({ page }) => {
  await start(page)
  await selectClient(page)
  await treatment(page)
  await timeAndPayment(page)
  await next(page)
  const holdKey = f.key()
  const hold = await f.publicApi.hold(f.date, 600, 60, holdKey)
  await page.getByRole('button', { name: 'Create booking', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(/available|slot|time|occupied/i)
  expect(await unwrap(f.admin.from('bookings').select('id').eq('client_id', f.recipient.id))).toEqual([])
  await f.publicApi.release(hold, holdKey)
})

test('responsive long client/address and four sessions fit all six requested widths', async ({ page }, testInfo) => {
  test.setTimeout(90000)
  await unwrap(f.admin.from('clients').update({ first_name: 'Alexandralongname'.repeat(6), email: `${'longemail'.repeat(12)}@example.test` }).eq('id', f.recipient.id))
  f.recipient.first_name = 'Alexandralongname'.repeat(6)
  f.recipient.email = `${'longemail'.repeat(12)}@example.test`
  await unwrap(f.admin.from('client_addresses').update({ address_line_1: 'LongAddressWithoutSpaces'.repeat(8) }).eq('id', f.addresses[0].id))
  await start(page)
  await page.getByLabel('Find a client').fill(f.recipient.email)
  await page.getByRole('button', { name: new RegExp(f.recipient.first_name) }).click()
  await page.getByRole('combobox', { name: 'Service area', exact: true }).selectOption(f.ids.area)
  async function capture(step) {
    for (const width of [320, 360, 390, 412, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${step} overflow at ${width}`).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`new-booking-${step}-${width}.png`), fullPage: true })
    }
  }
  await capture('client')
  await treatment(page, 4)
  await capture('four-sessions')
  await timeAndPayment(page)
  await capture('payment')
  await next(page)
  await capture('review')
  await page.getByRole('button', { name: 'Create booking', exact: true }).focus()
  await expect(page.getByRole('button', { name: 'Create booking', exact: true })).toBeFocused()
})
