import { test, expect } from '@playwright/test'
import { newBookingFixture } from '../newBookingFixture.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'
import { today } from '../../src/admin/calendarPresentation.js'

let f
test.beforeEach(async () => { f = await newBookingFixture(37) })
test.afterEach(async () => { await f?.cleanup() })

async function login(page, route = '/admin/day') {
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
// "More options" holds extra people and extras; open it only if it is closed.
async function openMore(page) {
  const more = page.locator('details.anb-more').filter({ hasText: 'More options' })
  if (!(await more.evaluate(element => element.open))) await more.locator('summary').first().click()
}
async function treatment(page, sessions = 1) {
  await page.getByRole('radio', { name: 'Integration massage', exact: true }).check()
  for (let i = 1; i <= sessions; i++) {
    if (i > 1) { await openMore(page); await page.getByRole('button', { name: '+ Add session', exact: true }).click() }
  }
  const first = page.locator('fieldset.anb-session').first()
  await first.locator('summary').filter({ hasText: 'Session preferences' }).click()
  await first.locator('summary').filter({ hasText: /^Focus(?! on)/ }).click()
  await first.getByRole('button', { name: 'Integration focus', exact: true }).click()
  await openMore(page)
  await page.getByRole('checkbox', { name: /Integration enhancement/ }).check()
}
async function pickTime(page) {
  await expect(page.getByLabel('Appointment date')).toHaveValue(f.date)
  await page.getByRole('group', { name: 'Available times' }).getByRole('button').first().click()
}

test('one page: saved address, sessions, authoritative quote, four payments and exactly-once success', async ({ page }) => {
  await start(page)
  await selectClient(page)
  await treatment(page, 2)
  await pickTime(page)
  for (const name of ['Bank transfer — payment pending', 'Bank transfer — already received', 'Cash — at appointment', 'Cash — already received']) {
    await page.getByRole('radio', { name, exact: true }).check()
    await expect(page.getByRole('radio', { name, exact: true })).toBeChecked()
  }
  await page.getByLabel('Appointment note (optional)').fill('Admin E2E appointment note')
  await expect(page.getByText('Use side entrance', { exact: true })).toBeVisible()
  await expect(page.locator('.anb-price').getByText('£200.00', { exact: true })).toBeVisible()
  await expect(page.getByText('Congestion fee', { exact: true })).toBeVisible()
  await expect(page.locator('.anb-footer-total')).toHaveText('Total £200.00')
  let creates = 0
  page.on('request', request => { if (request.url().includes('/rpc/admin_create_booking')) creates++ })
  await page.getByRole('button', { name: 'Create booking', exact: true }).evaluate(button => { button.click(); button.click() })
  await expect(page.getByRole('dialog')).toContainText('Admin E2E appointment note')
  expect(creates).toBe(1)
  const rows = await unwrap(f.admin.from('bookings').select('id,booking_payments(*)').eq('client_id', f.recipient.id))
  expect(rows).toHaveLength(1)
  expect(rows[0].booking_payments).toMatchObject({ method: 'cash', status: 'paid' })
  const people = await unwrap(f.admin.from('booking_sessions').select('position,recipient_name').eq('booking_id', rows[0].id).order('position'))
  expect(people.map(person => person.recipient_name)).toEqual(['Guest 1', 'Guest 2'])
  expect(await page.evaluate(id => sessionStorage.getItem(`admin-new-booking:v1:${id}`), f.user.id)).toBeNull()
  await page.getByRole('button', { name: 'Close details', exact: true }).click()
  await expect(page.getByLabel('Calendar date')).toHaveValue(f.date)
  await expect(page.locator('.admin-card')).toHaveCount(1)
})

test('choosing a client fills in their usual treatment, length, area and payment from their last booking', async ({ page }) => {
  const earlier = await unwrap(f.client.rpc('admin_create_booking', { p_request_id: crypto.randomUUID(), p_request: {
    client_id: f.recipient.id, saved_address_id: f.addresses[0].id, service_area_id: f.ids.area,
    sessions: [{ service_id: f.ids.service, duration_minutes: 90, recipient_name: 'Usual Person', preference_ids: [] }],
    enhancement_ids: [], date: f.date, start_minutes: 600, payment_arrangement: 'cash_appointment', note: null } }))
  expect(earlier).toHaveLength(1)
  await start(page)
  await page.getByLabel('Find a client').fill(f.recipient.email)
  await page.getByRole('button', { name: new RegExp(f.recipient.first_name) }).click()
  await expect(page.getByRole('combobox', { name: 'Service area', exact: true })).toHaveValue(f.ids.area)
  await expect(page.getByRole('radio', { name: 'Integration massage', exact: true })).toBeChecked()
  await expect(page.getByRole('radio', { name: /^90 min/ })).toBeChecked()
  await expect(page.getByRole('radio', { name: 'Cash — at appointment', exact: true })).toBeChecked()
  await expect(page.locator('.anb-footer-total')).toHaveText(/Total £/)
  await page.getByRole('button', { name: 'Change client', exact: true }).click()
  await expect(page.getByLabel('Find a client')).toBeVisible()
})

test('Create booking says what is still missing, in a plain sentence, and creates nothing', async ({ page }) => {
  await start(page)
  await page.getByRole('button', { name: 'Create booking', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Choose a client, appointment address and service area.')
  await selectClient(page)
  // A client with no history still gets the usual first choice, so what is missing now is the time.
  await page.getByRole('button', { name: 'Create booking', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Choose an available appointment time.')
  expect(await unwrap(f.admin.from('bookings').select('id').eq('client_id', f.recipient.id))).toEqual([])
})

test('Agenda entry defaults today, keeps the draft when leaving is declined, and confirms discard', async ({ page }) => {
  await start(page, true)
  await selectClient(page)
  await page.getByRole('radio', { name: 'One-off booking address', exact: true }).check()
  await page.getByRole('textbox', { name: 'Address', exact: true }).fill('99 Temporary Road, London, SW1A 1AA')
  await page.getByRole('radio', { name: 'Integration massage', exact: true }).check()
  await expect(page.getByLabel('Appointment date')).toHaveValue(today())
  page.once('dialog', dialog => dialog.dismiss())
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'New booking', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Address', exact: true })).toHaveValue('99 Temporary Road, London, SW1A 1AA')
  await expect(page.getByRole('radio', { name: 'Integration massage', exact: true })).toBeChecked()
  page.once('dialog', dialog => dialog.dismiss())
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'New booking', exact: true })).toBeVisible()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/agenda$/)
  expect(await unwrap(f.admin.from('client_addresses').select('address').eq('client_id', f.recipient.id))).toHaveLength(2)
})

test('inline client duplicate is actionable and new canonical client saves a default address', async ({ page }) => {
  await start(page)
  await page.getByRole('button', { name: '+ Add new client', exact: true }).click()
  await page.getByLabel('First name', { exact: true }).fill('Inline E2E')
  await page.getByLabel('Email', { exact: true }).fill(f.recipient.email)
  await page.getByRole('textbox', { name: 'Address (optional)', exact: true }).fill('33 Inline Road, London, SW1A 1AA')
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

test('a client can be added with only a name while booking, and the appointment address is typed for it', async ({ page }) => {
  await start(page)
  await page.getByRole('button', { name: '+ Add new client', exact: true }).click()
  await expect(page.getByText('Only the name is needed.')).toBeVisible()
  // Entry instructions with no address are caught before anything is sent; no address at all is fine.
  await page.getByLabel('First name', { exact: true }).fill('E2E-nameonly-booking')
  await page.getByRole('textbox', { name: 'Entry instructions (optional)', exact: true }).fill('Ring twice')
  await page.getByRole('button', { name: 'Save client', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Enter the address these instructions are for, or clear them.')
  await page.getByRole('textbox', { name: 'Entry instructions (optional)', exact: true }).fill('')
  await page.getByRole('button', { name: 'Save client', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'E2E-nameonly-booking', level: 3 })).toBeVisible()
  const client = await unwrap(f.admin.from('clients').select('id,email,phone').eq('first_name', 'E2E-nameonly-booking').single())
  f.trackRecipient(client.id)
  expect(client).toMatchObject({ email: null, phone: null })
  expect(await unwrap(f.admin.from('client_addresses').select('id').eq('client_id', client.id))).toEqual([])
  // No saved address yet, so this appointment's address is typed, as for any one-off address.
  await expect(page.getByRole('radio', { name: 'One-off booking address', exact: true })).toBeChecked()
  // The address is needed, and the booking says so before anything else is asked.
  await page.getByRole('combobox', { name: 'Service area', exact: true }).selectOption(f.ids.area)
  await page.getByRole('button', { name: 'Create booking', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Choose a client, appointment address and service area.')
  await page.getByRole('textbox', { name: 'Address', exact: true }).fill('5 Typed Road, London, SW1A 1AA')
  await treatment(page)
  await pickTime(page)
  await page.getByRole('button', { name: 'Create booking', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('E2E-nameonly-booking')
  const booking = await unwrap(f.admin.from('bookings').select('id,address_snapshot,booking_email_snapshot').eq('client_id', client.id).single())
  expect(booking).toMatchObject({ address_snapshot: '5 Typed Road, London, SW1A 1AA', booking_email_snapshot: null })
  // There is no one to email, so nothing is queued for the client.
  const events = await unwrap(f.admin.from('event_outbox').select('id').eq('aggregate_id', booking.id))
  const messages = await unwrap(f.admin.from('notification_deliveries').select('audience').in('event_id', events.map(event => event.id)))
  expect(messages.filter(message => message.audience === 'client')).toEqual([])
})

test('stale selected slot is rejected and no booking is created', async ({ page }) => {
  await start(page)
  await selectClient(page)
  await treatment(page)
  await pickTime(page)
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
  await unwrap(f.admin.from('client_addresses').update({ address: 'LongAddressWithoutSpaces'.repeat(8) }).eq('id', f.addresses[0].id))
  await start(page)
  await page.getByLabel('Find a client').fill(f.recipient.email)
  await page.getByRole('button', { name: new RegExp(f.recipient.first_name) }).click()
  await page.getByRole('combobox', { name: 'Service area', exact: true }).selectOption(f.ids.area)
  async function capture(step) {
    for (const width of [320, 360, 390, 412, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => {
        if (document.documentElement.scrollWidth <= innerWidth) return 'fits'
        return [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth + 0.5).slice(0, 5).map(el => `${el.tagName.toLowerCase()}.${el.className}`).join('; ')
      }), `${step} overflow at ${width}`).toBe('fits')
      await page.screenshot({ path: testInfo.outputPath(`new-booking-${step}-${width}.png`), fullPage: true })
    }
  }
  await capture('client')
  await treatment(page, 4)
  await capture('four-sessions')
  await pickTime(page)
  await capture('whole-page')
  await page.getByRole('button', { name: 'Create booking', exact: true }).focus()
  await expect(page.getByRole('button', { name: 'Create booking', exact: true })).toBeFocused()
})
