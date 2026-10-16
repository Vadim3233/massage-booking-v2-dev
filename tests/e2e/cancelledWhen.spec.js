import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'
import { shiftDate } from '../../src/admin/calendarPresentation.js'

// A cancelled booking says when it was cancelled. On the Admin's card, after the status: who cancelled it, the day and the time by the clock in
// London (on a line of its own when the status is long). On the page a client sees: one line under the heading, whether they signed in or came from
// the private link in an email. The moments are fixed so the clock can be checked: 1 July is summer time, an hour ahead of UTC, and 1 December is not.
// The year is added to a day that is not in this year, so the pattern allows it.
const SUMMER = '2026-07-01T17:20:00Z' // Wednesday 1 July, 18:20 in London
const WINTER = '2026-12-01T09:05:00Z' // Tuesday 1 December, 09:05 in London
let f
let D
test.beforeEach(async () => { f = await adminFixture(30); D = f.date })
test.afterEach(async () => {
  const mine = await unwrap(f.admin.from('bookings').select('id').like('booking_reference', 'CANCELWHEN-%'))
  const clients = await unwrap(f.admin.from('clients').select('id').like('email', '%.cancelwhen@example.test'))
  const ids = [...mine.map(booking => booking.id), ...clients.map(client => client.id)]
  if (ids.length) {
    const events = await unwrap(f.admin.from('event_outbox').select('id').in('aggregate_id', ids))
    if (events.length) await unwrap(f.admin.from('notification_deliveries').delete().in('event_id', events.map(event => event.id)))
    await unwrap(f.admin.from('event_outbox').delete().in('aggregate_id', ids))
  }
  await unwrap(f.admin.from('bookings').delete().like('booking_reference', 'CANCELWHEN-%'))
  await unwrap(f.admin.from('clients').delete().like('email', '%.cancelwhen@example.test'))
  await f?.cleanup()
})

let made = 0
// A booking, cancelled at a given moment unless `status` says otherwise, with its one treatment and its payment. It is a client of its own unless a client id is given.
async function booked({ first = 'Cora', last = 'Cancelled', clientId, day = 2, start = 600, at, by = 'client', pay = 'rejected', status = 'cancelled', ...fields }) {
  const { id, created_at, updated_at, ...copy } = f.bookings[0]
  void id; void created_at; void updated_at
  made += 1
  let client = clientId
  if (!client) {
    client = (await unwrap(f.admin.from('clients').insert({ first_name: first, last_name: last, email: `${first}.${made}.cancelwhen@example.test`.toLowerCase(), phone: `+4477009005${String(made).padStart(2, '0')}` }).select().single())).id
  }
  const booking = await unwrap(f.admin.from('bookings').insert({
    ...copy, client_id: client, date: shiftDate(D, day), start_minutes: start, treatment_duration_minutes: 60, travel_buffer_minutes: 0, booking_status: status,
    total_gbp: 85, service_subtotal_gbp: 85, booking_reference: `CANCELWHEN-${crypto.randomUUID()}`, booking_email_snapshot: f.email,
    ...(status === 'cancelled' ? { cancelled_at: at, cancelled_by_actor_type: by } : {}), ...fields,
  }).select().single())
  await unwrap(f.admin.from('booking_sessions').insert({ booking_id: booking.id, position: 1, service_id: f.ids.service, duration_minutes: 60, service_name_snapshot: 'Massage', unit_price_gbp: 85 }))
  await unwrap(f.admin.from('booking_payments').insert({ booking_id: booking.id, method: 'bank_transfer', status: pay, amount_gbp: 85, ...(pay === 'paid' ? { paid_at: new Date().toISOString() } : {}) }))
  return booking
}

async function openAgenda(page, width = 390) {
  await f.authorize()
  await page.setViewportSize({ width, height: 844 })
  await page.goto('/admin/agenda')
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('.admin-card').first()).toBeVisible()
  await page.getByRole('switch', { name: 'Show cancelled' }).check()
}
const card = (page, name) => page.locator('.admin-card', { hasText: name })

test('a cancelled card says who cancelled it and when, by the clock in London, and a card that is not cancelled says nothing of the kind', async ({ page }) => {
  await booked({ first: 'Rita', last: 'Refundowed', start: 540, at: SUMMER, by: 'client', pay: 'paid', refund_due_gbp: 85 })
  await booked({ first: 'Nadia', last: 'Plain', start: 780, at: WINTER, by: 'admin' })
  await booked({ first: 'Sam', last: 'Systemcancelled', start: 900, at: SUMMER, by: 'system' })
  await openAgenda(page)
  const note = name => card(page, name).locator('.admin-card-cancelled-when')
  await expect(note('Rita Refundowed')).toHaveText(/^by client · Wed 1 Jul( \d{4})?, 18:20$/)
  await expect(note('Nadia Plain')).toHaveText(/^by you · Tue 1 Dec( \d{4})?, 09:05$/)
  await expect(note('Sam Systemcancelled')).toHaveText(/^automatically · Wed 1 Jul( \d{4})?, 18:20$/)
  // The status is what it was, the money still to send included.
  await expect(card(page, 'Rita Refundowed').locator('.admin-status')).toHaveText('Cancelled · refund £85.00 to send')
  await expect(card(page, 'Nadia Plain').locator('.admin-status')).toHaveText('Cancelled')
  // Only cancelled cards have it.
  await expect(page.locator('.admin-card:not(.cancelled)').first()).toBeVisible()
  await expect(page.locator('.admin-card:not(.cancelled) .admin-card-cancelled-when')).toHaveCount(0)
  // The card still opens the booking, whose own page already says when and by whom.
  await card(page, 'Nadia Plain').click()
  await expect(page.getByRole('dialog').getByText('Cancelled by: ')).toBeVisible()
})

test('the note is readable, sits beside a short status and under a long one, and fits a 320px phone', async ({ page }) => {
  await booked({ first: 'Rita', last: 'Refundowed', start: 540, at: SUMMER, by: 'client', pay: 'paid', refund_due_gbp: 40, late_fee_status: 'due', late_fee_standard_gbp: 20, late_fee_due_gbp: 20 })
  await booked({ first: 'Nadia', last: 'Plain', start: 780, at: WINTER, by: 'admin' })
  await openAgenda(page)
  const boxes = async name => ({
    chip: await card(page, name).locator('.admin-status').boundingBox(), note: await card(page, name).locator('.admin-card-cancelled-when').boundingBox(), card: await card(page, name).boundingBox(),
  })
  const short = await boxes('Nadia Plain')
  expect(short.note.y, 'a short status has the note on its row').toBeLessThan(short.chip.y + short.chip.height)
  expect(short.note.x).toBeGreaterThan(short.chip.x + short.chip.width)
  const long = await boxes('Rita Refundowed')
  expect(long.note.y, 'a long status pushes the note to a line of its own').toBeGreaterThanOrEqual(long.chip.y + long.chip.height - 1)
  // The strength of the note's colour on the grey card, by the WCAG formula.
  const ratio = await card(page, 'Nadia Plain').evaluate(element => {
    const channels = value => value.match(/[\d.]+/g).slice(0, 3).map(Number)
    const luminance = ([r, g, b]) => { const f = c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
    const a = luminance(channels(getComputedStyle(element.querySelector('.admin-card-cancelled-when')).color)); const b = luminance(channels(getComputedStyle(element).backgroundColor))
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  })
  expect(ratio).toBeGreaterThanOrEqual(4.5)
  await page.setViewportSize({ width: 320, height: 800 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const name of ['Rita Refundowed', 'Nadia Plain']) {
    const { note, card: frame } = await boxes(name)
    expect(note.x + note.width, `${name}: the note stays inside its card`).toBeLessThanOrEqual(frame.x + frame.width)
  }
})

async function signedInClient(page, path = '/account') {
  await page.goto(path)
  await page.getByLabel('Email address', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

test('the page a signed-in client sees says when the booking was cancelled, and a booking that is not cancelled does not', async ({ page }) => {
  const gone = await booked({ clientId: f.profile.client_id, day: 3, start: 660, at: SUMMER, by: 'client', pay: 'paid', late_fee_status: 'due', late_fee_standard_gbp: 20, late_fee_due_gbp: 20 })
  const kept = await booked({ clientId: f.profile.client_id, day: 4, start: 720, status: 'confirmed', pay: 'approved' })
  await page.setViewportSize({ width: 390, height: 844 })
  await signedInClient(page, `/account?booking=${gone.id}`)
  await expect(page.getByRole('heading', { name: 'Your appointment is cancelled', level: 1 })).toBeVisible()
  await expect(page.locator('.account-cancelled-on')).toHaveText(/^Cancelled on Wednesday 1 July( \d{4})? at 18:20\.$/)
  // It sits right under the heading, above the summary, and the late fee note is still there below it.
  const heading = await page.getByRole('heading', { name: 'Your appointment is cancelled', level: 1 }).boundingBox()
  const line = await page.locator('.account-cancelled-on').boundingBox()
  const summary = await page.getByLabel('Appointment summary').boundingBox()
  expect(line.y).toBeGreaterThanOrEqual(heading.y + heading.height - 8)
  expect(line.y + line.height).toBeLessThanOrEqual(summary.y)
  await expect(page.getByText(/late fee of £20\.00 is due/i)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.goto(`/account?booking=${kept.id}`)
  await expect(page.getByRole('heading', { name: 'Your appointment is confirmed', level: 1 })).toBeVisible()
  await expect(page.locator('.account-cancelled-on')).toHaveCount(0)
})

test('the same line is on the page opened from the private link in an email, with no sign-in', async ({ page }) => {
  const guest = await unwrap(f.admin.from('clients').insert({ first_name: 'Gwen', last_name: 'Guest', email: 'gwen.guest.cancelwhen@example.test', phone: '+447700900599' }).select().single())
  const gone = await booked({ clientId: guest.id, day: 5, start: 840, at: WINTER, by: 'admin' })
  const code = await unwrap(f.admin.rpc('mint_booking_access_token', { p_booking_id: gone.id }))
  await page.goto(`/account?booking=${gone.id}#key=${code}`)
  await expect(page.getByRole('heading', { name: 'Your appointment is cancelled', level: 1 })).toBeVisible()
  await expect(page.locator('.account-cancelled-on')).toHaveText(/^Cancelled on Tuesday 1 December( \d{4})? at 09:05\.$/)
  await expect(page.getByText('Sign in to see your bookings')).toHaveCount(0)
})
