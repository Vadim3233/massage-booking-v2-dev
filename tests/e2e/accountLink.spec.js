import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'
import { londonSlot } from '../londonSlot.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'
import { shiftDate, today } from '../../src/admin/calendarPresentation.js'

let f
const clients = []
test.beforeEach(async () => { f = await adminFixture(38); clients.length = 0 })
test.afterEach(async () => {
  for (const id of clients) {
    const ids = ((await f.admin.from('bookings').select('id').eq('client_id', id)).data ?? []).map(row => row.id)
    if (ids.length) await f.admin.from('event_outbox').delete().in('aggregate_id', ids)
    await f.admin.from('bookings').delete().eq('client_id', id)
    await f.admin.from('clients').delete().eq('id', id)
  }
  await f.admin.from('clients').delete().like('email', 'e2e-link-%')
  await f.admin.from('working_hours_overrides').delete().in('date', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(day => shiftDate(today(), day)))
  await f?.cleanup()
})

const randomPhone = () => `07700 9${String(Math.floor(Math.random() * 90000) + 10000)}`
// A client and a booking made directly in the database, and the private code the sender would put in their email.
async function made({ date, start = 600, createdAgo = 3 * 86400000, status = 'confirmed', login = false } = {}) {
  const email = `e2e-link-${crypto.randomUUID()}@example.test`
  const owner = { first_name: 'Link', last_name: 'Linkable', email, phone: randomPhone() }
  const password = `Test-only-${crypto.randomUUID()}`
  if (login) {
    const { user } = await unwrap(f.admin.auth.admin.createUser({ email, password, email_confirm: true }))
    owner.auth_user_id = user.id
  }
  const client = await unwrap(f.admin.from('clients').insert(owner).select().single())
  clients.push(client.id)
  const booking = await unwrap(f.admin.from('bookings').insert({ client_id: client.id, service_area_id: f.ids.area, date, start_minutes: start, treatment_duration_minutes: 60, booking_status: status,
    source_channel: 'web', address_line_1_snapshot: '12 Garden Road', city_snapshot: 'London', postcode_snapshot: 'SW1A2AA', service_area_name_snapshot: 'Test area',
    service_subtotal_gbp: 85, total_gbp: 85, booking_email_snapshot: email, booking_reference: `E2ELINK-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    created_at: new Date(Date.now() - createdAgo).toISOString() }).select().single())
  await unwrap(f.admin.from('booking_payments').insert({ booking_id: booking.id, method: 'cash', status: 'approved', amount_gbp: 85 }))
  const code = await unwrap(f.admin.rpc('mint_booking_access_token', { p_booking_id: booking.id }))
  return { client, booking, code, path: `/account?booking=${booking.id}`, link: `/account?booking=${booking.id}#key=${code}`, email, password, authUserId: owner.auth_user_id }
}
const openDays = () => unwrap(f.admin.from('working_hours_overrides').upsert([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(day => ({ date: shiftDate(today(), day), available: true, start_minutes: 480, end_minutes: 1200, start_mode: 'flexible', fixed_start_minutes: null }))))
const heading = (page, name) => page.getByRole('heading', { name, level: 1 })
const row = async id => (await f.admin.from('bookings').select('booking_status,date,start_minutes,late_fee_due_gbp,late_fee_status').eq('id', id).single()).data

test('the link opens the booking on a browser that never saw it, with no sign-in, and the code leaves the address bar', async ({ page }) => {
  const one = await made({ date: shiftDate(today(), 5) })
  await page.goto(one.link)
  await expect(heading(page, 'Your appointment is confirmed')).toBeVisible()
  await expect(page.getByText(`E2ELINK`)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Change the time' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel appointment' })).toBeVisible()
  await expect(page.getByText('Sign in to see your bookings')).toHaveCount(0)
  // There is no list of other bookings to go back to: that needs a sign-in. A way to sign in is offered instead.
  await expect(page.getByRole('button', { name: 'Your bookings' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'sign in' })).toHaveAttribute('href', '/account')
  // The code is not left in the address, so a copied address or a screenshot does not carry it.
  await expect(page).toHaveURL(new RegExp(`/account\\?booking=${one.booking.id}$`))
  expect(await page.evaluate(() => window.location.hash)).toBe('')
  // A reload in the same tab still works.
  await page.reload()
  await expect(heading(page, 'Your appointment is confirmed')).toBeVisible()
  // The same address without the code, in another browser, is the sign-in page, with a line for guests.
  const other = await page.context().browser().newContext()
  const stranger = await other.newPage()
  await stranger.goto(one.path)
  await expect(stranger.getByRole('heading', { name: 'Sign in to see your bookings' })).toBeVisible()
  await expect(stranger.getByText('Booked as a guest? There is no password to enter.')).toBeVisible()
  await other.close()
})

test('it works for a client with a login, for one the Admin added with none, and while signed in as someone else', async ({ page, browser }) => {
  const registered = await made({ date: shiftDate(today(), 5), login: true })
  const added = await made({ date: shiftDate(today(), 6) })
  await page.goto(registered.link)
  await expect(heading(page, 'Your appointment is confirmed')).toBeVisible()
  await page.goto(added.link)
  await expect(heading(page, 'Your appointment is confirmed')).toBeVisible()
  // Someone who is signed in as themselves (here, the Admin) and opens another person's link sees that booking, not an error.
  await f.authorize()
  const signedIn = await browser.newContext()
  const admin = await signedIn.newPage()
  await admin.goto('/account')
  await admin.getByLabel('Email address', { exact: true }).fill(f.email)
  await admin.getByLabel('Password', { exact: true }).fill(f.password)
  await admin.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(admin.getByRole('heading', { name: 'Your bookings', level: 1, exact: true })).toBeVisible()
  await admin.goto(registered.link)
  await expect(heading(admin, 'Your appointment is confirmed')).toBeVisible()
  // Without the code (the tab no longer holds it) the same person is told plainly why it is not shown.
  await admin.evaluate(() => sessionStorage.clear())
  await admin.goto(registered.path)
  await expect(admin.getByRole('alert')).toContainText('This appointment is not on the account you are signed in to.')
  await expect(admin.getByRole('alert')).not.toContainText('Something went wrong')
  await signedIn.close()
})

test('a wrong or lapsed code says so in plain words, and shows nothing about the booking', async ({ page }) => {
  const one = await made({ date: shiftDate(today(), 5) })
  await page.goto(`${one.path}#key=${'a'.repeat(64)}`)
  await expect(page.getByRole('alert')).toHaveText('This link is not valid or has expired. Please contact Vad.')
  // A page with a problem still has a title for a screen reader to announce.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your appointment')
  // A client with an account is not left with nowhere to go.
  await expect(page.getByRole('link', { name: 'sign in' })).toHaveAttribute('href', '/account')
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
  await expect(page.getByText('E2ELINK')).toHaveCount(0)
  await expect(page.getByText('12 Garden Road')).toHaveCount(0)
  await f.admin.from('booking_access_tokens').update({ expires_at: new Date(Date.now() - 60000).toISOString() }).eq('booking_id', one.booking.id)
  await page.goto(one.link)
  await expect(page.getByRole('alert')).toHaveText('This link is not valid or has expired. Please contact Vad.')
})

test('cancelling from the link cancels the booking, says so, and emails the client', async ({ page }) => {
  const one = await made({ date: shiftDate(today(), 5) })
  await page.goto(one.link)
  await page.getByRole('button', { name: 'Cancel appointment' }).click()
  await expect(page.getByRole('heading', { name: 'Cancel this appointment?' })).toBeVisible()
  await expect(page.getByText(/No charge\./)).toBeVisible()
  await page.getByLabel(/Anything you would like me to know/).fill('Plans changed')
  await page.getByRole('button', { name: 'Cancel appointment' }).last().click()
  await expect(page.getByText('Your appointment is cancelled.')).toBeVisible()
  await expect(heading(page, 'Your appointment is cancelled')).toBeVisible()
  expect((await row(one.booking.id)).booking_status).toBe('cancelled')
  const mails = (await f.admin.from('notification_deliveries').select('title, recipient, event_outbox!inner(aggregate_id)').eq('event_outbox.aggregate_id', one.booking.id).eq('audience', 'client')).data
  expect(mails).toEqual([expect.objectContaining({ title: 'Your appointment is cancelled', recipient: one.email })])
})

test('a late cancellation shows the fee and waits for it to be acknowledged, as it does when signed in', async ({ page }) => {
  const slot = londonSlot(5 * 3600000)
  const late = await made({ date: slot.date, start: slot.start })
  await page.goto(late.link)
  await page.getByRole('button', { name: 'Cancel appointment' }).click()
  await expect(page.getByText(/late fee of £[0-9.]+ applies/).first()).toBeVisible()
  const submit = page.getByRole('button', { name: 'Cancel appointment' }).last()
  await expect(submit).toBeDisabled()
  await page.getByLabel(/I understand a late fee of/).check()
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(page.getByText('Your appointment is cancelled.')).toBeVisible()
  const after = await row(late.booking.id)
  expect(after.booking_status).toBe('cancelled')
  expect(Number(after.late_fee_due_gbp)).toBeGreaterThan(0)
  expect(after.late_fee_status).toBe('due')
})

test('moving from the link moves the booking to the time chosen', async ({ page }) => {
  await openDays()
  const one = await made({ date: shiftDate(today(), 8), start: 600 })
  await page.goto(one.link)
  await page.getByRole('button', { name: 'Change the time' }).click()
  await expect(page.getByRole('heading', { name: 'Choose a new time' })).toBeVisible()
  const times = page.getByRole('group', { name: 'Available times' })
  await expect(times).toBeVisible()
  const first = times.locator('.slots button').first()
  const label = (await first.innerText()).trim()
  await first.click()
  await page.getByRole('button', { name: 'Move my appointment' }).click()
  await expect(page.getByText('Your appointment has been moved.')).toBeVisible()
  const after = await row(one.booking.id)
  expect(`${String(Math.floor(after.start_minutes / 60)).padStart(2, '0')}:${String(after.start_minutes % 60).padStart(2, '0')}`).toBe(label)
  expect(after.date !== shiftDate(today(), 8) || after.start_minutes !== 600).toBe(true)
})

test('moving inside 24 hours shows the late fee and waits for it to be acknowledged, as it does when signed in', async ({ page }) => {
  await openDays()
  const slot = londonSlot(5 * 3600000)
  const late = await made({ date: slot.date, start: slot.start })
  await page.goto(late.link)
  await page.getByRole('button', { name: 'Change the time' }).click()
  await expect(page.getByText(/late fee of £[0-9.]+ applies/).first()).toBeVisible()
  await page.getByLabel('New date').fill(shiftDate(today(), 4))
  const slots = page.getByRole('group', { name: 'Available times' }).getByRole('button')
  await expect(slots.first()).toBeVisible()
  await slots.first().click()
  const move = page.getByRole('button', { name: 'Move my appointment' })
  await expect(move).toBeDisabled()
  await page.getByLabel(/I understand a late fee of/).check()
  await expect(move).toBeEnabled()
  await move.click()
  await expect(page.getByText('Your appointment has been moved.')).toBeVisible()
  const after = await row(late.booking.id)
  expect(after.date).toBe(shiftDate(today(), 4))
  expect(Number(after.late_fee_due_gbp)).toBeGreaterThan(0)
  expect(after.late_fee_status).toBe('due')
})

test('a newer link for the same booking, opened in the same tab after an old one, takes over', async ({ page }) => {
  const one = await made({ date: shiftDate(today(), 5) })
  await page.goto(`${one.path}#key=${'a'.repeat(64)}`)
  await expect(page.getByRole('alert')).toHaveText('This link is not valid or has expired. Please contact Vad.')
  // Only the part after the # changes, so the page is not reloaded: it has to notice the new code by itself.
  await page.goto(one.link)
  await expect(heading(page, 'Your appointment is confirmed')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('where the browser will not keep the code, it stays in the address so a reload still opens the booking', async ({ page }) => {
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) { if (String(key).startsWith('vad-booking-link:')) throw new Error('storage is full'); return set.call(this, key, value) }
  })
  const one = await made({ date: shiftDate(today(), 5) })
  await page.goto(one.link)
  await expect(heading(page, 'Your appointment is confirmed')).toBeVisible()
  expect(await page.evaluate(() => window.location.hash)).toContain('#key=')
  await page.reload()
  await expect(heading(page, 'Your appointment is confirmed')).toBeVisible()
})

test('a full stop or bracket that a mail app adds after the link does not stop it working', async ({ page }) => {
  const one = await made({ date: shiftDate(today(), 5) })
  await page.goto(`${one.link}.`)
  await expect(heading(page, 'Your appointment is confirmed')).toBeVisible()
  // A tab of its own, so the code has to come from the address and not from what the first tab kept.
  const second = await page.context().newPage()
  await second.goto(`${one.link})`)
  await expect(heading(second, 'Your appointment is confirmed')).toBeVisible()
})

test('a client who is signed in opens their own link and sees that booking, and can still reach their list', async ({ page }) => {
  const mine = await made({ date: shiftDate(today(), 5), login: true })
  await page.goto('/account')
  await page.getByLabel('Email address', { exact: true }).fill(mine.email)
  await page.getByLabel('Password', { exact: true }).fill(mine.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your bookings', level: 1, exact: true })).toBeVisible()
  await page.goto(mine.link)
  await expect(heading(page, 'Your appointment is confirmed')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Your bookings' })).toHaveCount(0)
  await page.getByRole('link', { name: 'sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Your bookings', level: 1, exact: true })).toBeVisible()
})

test('the page fits a phone, a very small phone and a wide screen', async ({ page }) => {
  const one = await made({ date: shiftDate(today(), 5) })
  for (const [width, height] of [[390, 844], [320, 700], [1280, 860]]) {
    await page.setViewportSize({ width, height })
    await page.goto(one.link)
    await expect(heading(page, 'Your appointment is confirmed')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    await page.goto(`${one.path}#key=${'b'.repeat(64)}`)
    await expect(page.getByRole('alert')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  }
})
