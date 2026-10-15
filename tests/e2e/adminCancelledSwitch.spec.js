import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'
import { shiftDate } from '../../src/admin/calendarPresentation.js'

// Cancelled bookings are left out of the Admin's lists unless "Show cancelled" is on, except one with money still to sort out. The fixture's own
// day (today plus 5, D) has a confirmed booking at 10:00 and a plain cancelled one at 13:00, and D+1 has one more confirmed booking. Added here:
// D 15:00 a cancelled booking with a refund still to send; D+2 a day with only a cancelled booking; D+3 two cancelled bookings, one with a late
// fee still due and one with both a refund and a late fee.
let f
let D
test.beforeEach(async () => { f = await adminFixture(5); D = f.date })
test.afterEach(async () => {
  const mine = await unwrap(f.admin.from('bookings').select('id').like('booking_reference', 'CANCELSWITCH-%'))
  const clients = await unwrap(f.admin.from('clients').select('id').like('email', '%.cancelswitch@example.test'))
  const ids = [...mine.map(booking => booking.id), ...clients.map(client => client.id)]
  if (ids.length) {
    const events = await unwrap(f.admin.from('event_outbox').select('id').in('aggregate_id', ids))
    if (events.length) await unwrap(f.admin.from('notification_deliveries').delete().in('event_id', events.map(event => event.id)))
    await unwrap(f.admin.from('event_outbox').delete().in('aggregate_id', ids))
  }
  await unwrap(f.admin.from('bookings').delete().like('booking_reference', 'CANCELSWITCH-%'))
  await unwrap(f.admin.from('clients').delete().like('email', '%.cancelswitch@example.test'))
  await f?.cleanup()
})

async function seed() {
  const { id, created_at, updated_at, ...copy } = f.bookings[0]
  void id; void created_at; void updated_at
  const made = {}
  let n = 0
  const make = async (key, first, last, { day = 0, start, pay = 'rejected', ...fields }) => {
    n += 1
    const client = await unwrap(f.admin.from('clients').insert({ first_name: first, last_name: last, email: `${key}.cancelswitch@example.test`, phone: `+4477009003${String(n).padStart(2, '0')}` }).select().single())
    const booking = await unwrap(f.admin.from('bookings').insert({
      ...copy, client_id: client.id, date: shiftDate(D, day), start_minutes: start, treatment_duration_minutes: 60, travel_buffer_minutes: 0, booking_status: 'cancelled',
      total_gbp: 85, service_subtotal_gbp: 85, booking_reference: `CANCELSWITCH-${crypto.randomUUID()}`, cancelled_at: new Date().toISOString(), cancelled_by_actor_type: 'admin', ...fields,
    }).select().single())
    await unwrap(f.admin.from('booking_sessions').insert({ booking_id: booking.id, position: 1, service_id: f.ids.service, duration_minutes: 60, service_name_snapshot: 'Massage', unit_price_gbp: 85 }))
    await unwrap(f.admin.from('booking_payments').insert({ booking_id: booking.id, method: 'bank_transfer', status: pay, amount_gbp: 85, ...(pay === 'paid' ? { paid_at: new Date().toISOString() } : {}) }))
    made[key] = booking
  }
  await make('refund', 'Rita', 'Refundowed', { day: 0, start: 900, pay: 'paid', refund_due_gbp: 85 })
  await make('only', 'Nadia', 'Onlycancelled', { day: 2, start: 660 })
  await make('fee', 'Lena', 'Latefee', { day: 3, start: 660, pay: 'paid', late_fee_status: 'due', late_fee_standard_gbp: 20, late_fee_due_gbp: 20 })
  await make('both', 'Bea', 'Bothowed', { day: 3, start: 840, pay: 'paid', refund_due_gbp: 40, late_fee_status: 'due', late_fee_standard_gbp: 20, late_fee_due_gbp: 20 })
  return made
}

async function login(page) {
  await page.goto('/admin/agenda')
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
async function openAgenda(page, width = 390) {
  await f.authorize()
  await page.setViewportSize({ width, height: 844 })
  await login(page)
  await expect(page.locator('.admin-card').first()).toBeVisible()
}
const card = (page, name) => page.locator('.admin-card', { hasText: name })
const cancelledShown = page => page.getByRole('switch', { name: 'Show cancelled' })
const everyDay = page => page.getByRole('switch', { name: 'Show every day' })
const dayHeading = (page, date) => page.locator(`#agenda-${date}`)

test('cancelled bookings are not listed by default, and a day with only cancelled bookings is not listed at all', async ({ page }) => {
  await seed()
  await openAgenda(page)
  await expect(cancelledShown(page)).not.toBeChecked()
  // The confirmed bookings, and the three cancelled ones that still have money to sort out.
  await expect(page.locator('.admin-card')).toHaveCount(5)
  await expect(page.locator('.admin-card.cancelled')).toHaveCount(3)
  await expect(card(page, 'Rita Refundowed')).toHaveCount(1)
  await expect(card(page, 'Nadia Onlycancelled')).toHaveCount(0)
  // D has a confirmed booking, a plain cancelled one (out of sight) and the one with a refund to send.
  await expect(dayHeading(page, D)).toHaveCount(1)
  await expect(page.locator('.admin-agenda-day', { has: dayHeading(page, D) }).locator('.admin-card')).toHaveCount(2)
  // D+2 has only a plain cancelled booking, so the day is not on the list.
  await expect(dayHeading(page, shiftDate(D, 2))).toHaveCount(0)
  // Today is always there, with or without bookings.
  await expect(page.locator('.admin-agenda-day.is-today')).toHaveCount(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('Show cancelled lists every cancelled booking again, with the day that had only those, and the choice is remembered', async ({ page }) => {
  await seed()
  await openAgenda(page)
  await cancelledShown(page).check()
  await expect(page.locator('.admin-card')).toHaveCount(7)
  await expect(page.locator('.admin-card.cancelled')).toHaveCount(5)
  await expect(card(page, 'Nadia Onlycancelled')).toHaveCount(1)
  await expect(dayHeading(page, shiftDate(D, 2))).toHaveCount(1)
  // A day heading counts what is going ahead, so a day of cancelled bookings says so.
  await expect(page.locator('.admin-agenda-day', { has: dayHeading(page, shiftDate(D, 2)) }).locator('.admin-agenda-day-heading')).toContainText('All cancelled')
  await page.reload()
  await expect(cancelledShown(page)).toBeChecked()
  await expect(page.locator('.admin-card')).toHaveCount(7)
  await cancelledShown(page).uncheck()
  await expect(page.locator('.admin-card')).toHaveCount(5)
  await page.reload()
  await expect(cancelledShown(page)).not.toBeChecked()
  await expect(page.locator('.admin-card')).toHaveCount(5)
})

test('a cancelled booking with money still to sort out stays listed, and says what is owed', async ({ page }) => {
  await seed()
  await openAgenda(page)
  const status = name => card(page, name).locator('.admin-status')
  await expect(status('Rita Refundowed')).toHaveText('Cancelled · refund £85.00 to send')
  await expect(status('Lena Latefee')).toHaveText('Cancelled · late fee £20.00 due')
  await expect(status('Bea Bothowed')).toHaveText('Cancelled · refund £40.00 to send · late fee £20.00 due')
  // Its status is in the colour of things that need the Admin, on a card that is still the grey of a cancelled one.
  await expect(status('Rita Refundowed')).toHaveClass(/chip--needs/)
  await expect(card(page, 'Rita Refundowed')).toHaveClass(/cancelled/)
  // It is a card like the others: the whole text fits inside it, at the smallest width as well.
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    const fits = await page.evaluate(() => [...document.querySelectorAll('.admin-card.cancelled')].every(node => {
      const chip = node.querySelector('.admin-status').getBoundingClientRect()
      const box = node.getBoundingClientRect()
      return chip.right <= box.right && chip.left >= box.left && node.scrollWidth <= node.clientWidth + 1
    }))
    expect(fits).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  // A plain cancelled card says only that it is cancelled, once it is shown.
  await cancelledShown(page).check()
  await expect(card(page, 'Nadia Onlycancelled').locator('.admin-status')).toHaveText('Cancelled')
  await expect(card(page, 'Nadia Onlycancelled').locator('.admin-status')).toHaveClass(/chip--cancel/)
})

test('once the refund is recorded, or the late fee is dealt with, the cancelled booking drops out of the list', async ({ page }) => {
  const made = await seed()
  await openAgenda(page)
  await expect(page.locator('.admin-card')).toHaveCount(5)
  await unwrap(f.admin.from('bookings').update({ refund_due_gbp: 0 }).eq('id', made.refund.id))
  await unwrap(f.admin.from('bookings').update({ late_fee_status: 'received' }).eq('id', made.fee.id))
  await page.getByRole('button', { name: /Refresh/ }).click()
  await expect(card(page, 'Rita Refundowed')).toHaveCount(0)
  await expect(card(page, 'Lena Latefee')).toHaveCount(0)
  // The one that owes both stays. Waiving its late fee leaves only the refund to name.
  await expect(card(page, 'Bea Bothowed')).toHaveCount(1)
  await unwrap(f.admin.from('bookings').update({ late_fee_status: 'waived', late_fee_due_gbp: 0 }).eq('id', made.both.id))
  await page.getByRole('button', { name: /Refresh/ }).click()
  await expect(card(page, 'Bea Bothowed').locator('.admin-status')).toHaveText('Cancelled · refund £40.00 to send')
  await unwrap(f.admin.from('bookings').update({ refund_due_gbp: 0 }).eq('id', made.both.id))
  await page.getByRole('button', { name: /Refresh/ }).click()
  await expect(card(page, 'Bea Bothowed')).toHaveCount(0)
  await expect(page.locator('.admin-card')).toHaveCount(2)
  // The day those two were on, D+3, has nothing left to list.
  await expect(dayHeading(page, shiftDate(D, 3))).toHaveCount(0)
})

test('Show every day and Show cancelled are separate, are named, work from the keyboard, and share one line on every phone', async ({ page }) => {
  await seed()
  await openAgenda(page)
  await expect(page.getByRole('group', { name: 'What the Agenda lists' })).toBeVisible()
  // Separate: one does not move the other.
  await everyDay(page).check()
  await expect(cancelledShown(page)).not.toBeChecked()
  await expect(page.locator('.admin-card')).toHaveCount(5)
  await cancelledShown(page).check()
  await expect(everyDay(page)).toBeChecked()
  await expect(page.locator('.admin-card')).toHaveCount(7)
  await everyDay(page).uncheck()
  await expect(cancelledShown(page)).toBeChecked()
  await cancelledShown(page).uncheck()
  // From the keyboard: focus it, press Space.
  await cancelledShown(page).focus()
  await page.keyboard.press('Space')
  await expect(cancelledShown(page)).toBeChecked()
  await page.keyboard.press('Space')
  await expect(cancelledShown(page)).not.toBeChecked()
  // Both on one line, inside the page, each 44px or more to press, with no sideways scrolling, down to the smallest phone.
  for (const width of [390, 360, 320]) {
    await page.setViewportSize({ width, height: 844 })
    const where = await page.evaluate(() => {
      const [first, second] = [...document.querySelectorAll('.admin-agenda-switch')].map(label => label.getBoundingClientRect())
      return { sameLine: Math.abs(first.top - second.top) < 1, inside: second.right <= innerWidth - 12 && first.left >= 12, tall: Math.min(first.height, second.height), wide: Math.min(first.width, second.width), sideways: document.documentElement.scrollWidth > innerWidth }
    })
    expect(where, `at ${width}px`).toMatchObject({ sameLine: true, inside: true, sideways: false })
    expect(where.tall).toBeGreaterThanOrEqual(44)
    expect(where.wide).toBeGreaterThanOrEqual(44)
  }
  // The date button keeps a line above them.
  const pick = await page.locator('.admin-agenda-pick').boundingBox()
  const first = await page.locator('.admin-agenda-switch').first().boundingBox()
  expect(pick.y + pick.height).toBeLessThanOrEqual(first.y + 1)
})

test("the Day view and a day's own page follow the choice, say how many are out of sight, and can bring them back", async ({ page }) => {
  await seed()
  await openAgenda(page)
  await page.goto(`/admin?date=${D}`)
  // D: the confirmed booking and the one with a refund to send; the plain cancelled one is out of sight.
  const toggle = name => page.getByRole('button', { name })
  await expect(page.locator('.admin-card')).toHaveCount(2)
  await expect(toggle('Show 1 cancelled booking')).toBeVisible()
  await toggle('Show 1 cancelled booking').click()
  await expect(page.locator('.admin-card')).toHaveCount(3)
  await expect(toggle('Hide cancelled bookings')).toBeVisible()
  // It is the one choice: the Agenda has it on now.
  await page.getByRole('navigation', { name: 'Calendar views' }).getByRole('link', { name: 'Agenda', exact: true }).click()
  await expect(cancelledShown(page)).toBeChecked()
  // A day's own page asks the same, and puts them away again.
  await page.goto(`/admin/day-settings?date=${D}`)
  const list = page.getByRole('list', { name: /^Bookings for / })
  await expect(list.locator('.admin-card')).toHaveCount(3)
  await toggle('Hide cancelled bookings').click()
  await expect(list.locator('.admin-card')).toHaveCount(2)
  await expect(toggle('Show 1 cancelled booking')).toBeVisible()
  // A day with nothing cancelled has no such line at all.
  await page.goto(`/admin?date=${shiftDate(D, 1)}`)
  await expect(page.locator('.admin-card')).toHaveCount(1)
  await expect(page.getByRole('button', { name: /cancelled booking/ })).toHaveCount(0)
  // And a day with only a cancelled booking says there is nothing going ahead, and offers it.
  await page.goto(`/admin?date=${shiftDate(D, 2)}`)
  await expect(page.getByText('No appointments for this day.')).toBeVisible()
  await expect(toggle('Show 1 cancelled booking')).toBeVisible()
})
