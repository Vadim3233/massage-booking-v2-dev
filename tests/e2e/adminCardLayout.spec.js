import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'
import { dateLabel } from '../../src/admin/calendarPresentation.js'

// The fixture's own day (today plus 5) has a confirmed booking at 10:00 for a client whose name is 108 letters with no spaces (the worst case
// for a card), a cancelled one at 13:00, and one more on the day after. The cards are as wide as the screen allows and carry their own time.
let f
const undo = []
test.beforeEach(async () => { f = await adminFixture(5) })
test.afterEach(async () => {
  for (const step of undo.splice(0).reverse()) await step()
  await f.admin.from('calendar_blocks').delete().eq('title', 'Card layout dentist')
  await f?.cleanup()
})

async function login(page, path = '/admin/agenda') {
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
async function openAgenda(page, width = 390) {
  await f.authorize()
  await page.setViewportSize({ width, height: 844 })
  await login(page)
  await expect(page.locator('.admin-card')).toHaveCount(3)
}
const noSideways = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
const box = locator => locator.evaluate(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } })
const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
const first = page => page.locator('.admin-card').first()

for (const width of [390, 320]) {
  test(`cards use the width of the screen and need no column of times beside them, at ${width}px`, async ({ page }) => {
    await openAgenda(page, width)
    await expect(page.locator('.admin-time')).toHaveCount(0)
    for (const card of await page.locator('.admin-card').all()) {
      const { left, right } = await box(card)
      expect(left, 'a little space at the left').toBeGreaterThanOrEqual(8)
      expect(left).toBeLessThanOrEqual(20)
      expect(width - right, 'and the same at the right').toBeGreaterThanOrEqual(8)
      expect(width - right).toBeLessThanOrEqual(20)
    }
    expect(await noSideways(page)).toBe(true)
    await page.screenshot({ path: `test-results/card-layout-agenda-${width}.png`, fullPage: true })
  })
}

test('the time is inside the card, from when the treatment starts to when it ends, with its length beside it', async ({ page }) => {
  await openAgenda(page)
  await expect(first(page).locator('.admin-card-times')).toContainText('10:00')
  await expect(first(page).locator('.admin-card-times')).toContainText('11:00')
  await expect(first(page).locator('.admin-card-length')).toHaveText('60 min')
  // Said in words for a screen reader, not as two numbers with a dash between them.
  await expect(page.getByRole('button', { name: /10:00 to 11:00/ })).toHaveCount(1)
  // The treatment's name is no longer followed by its length, which is on its own at the top.
  await expect(first(page).locator('.admin-card-treatment')).not.toContainText('min')
  await expect(first(page).locator('.admin-card-postcode')).toHaveText('SW1A 1AA')
  // The divider under the time is a real line between it and the client.
  expect(await first(page).locator('.admin-card-when').evaluate(node => getComputedStyle(node).borderBottomWidth)).toBe('1px')
})

test("the end is the treatment's own end, not the start plus an hour and not the time the travel either side takes", async ({ page }) => {
  // Two sessions of one booking, 60 and 60 minutes, so the treatment is two hours; the travel either side (45 minutes) is a different thing.
  const booking = f.bookings[0]
  await unwrap(f.admin.from('booking_sessions').insert({ booking_id: booking.id, position: 2, service_id: f.ids.service, duration_minutes: 60, service_name_snapshot: 'Second session', unit_price_gbp: 85 }))
  await unwrap(f.admin.from('bookings').update({ treatment_duration_minutes: 120, travel_buffer_minutes: 45 }).eq('id', booking.id))
  await openAgenda(page)
  await expect(page.getByRole('button', { name: /10:00 to 12:00/ })).toHaveCount(1)
  await expect(first(page).locator('.admin-card-length')).toHaveText('120 min')
  await expect(first(page).locator('.admin-card-treatment')).toHaveText('2 sessions')
})

test('a cancelled card is grey and quiet, with its name and price struck through, and it has no Directions button', async ({ page }) => {
  await openAgenda(page)
  const cancelled = page.locator('.admin-card.cancelled')
  await expect(cancelled).toHaveCount(1)
  const style = node => getComputedStyle(node)
  expect(await cancelled.locator('.admin-card-heading strong').evaluate(node => style(node).textDecorationLine)).toContain('line-through')
  expect(await cancelled.locator('.admin-card-price').evaluate(node => style(node).textDecorationLine)).toContain('line-through')
  // Not struck through: when it was, which is still worth reading.
  expect(await cancelled.locator('.admin-card-times').evaluate(node => style(node).textDecorationLine)).not.toContain('line-through')
  const grey = await cancelled.evaluate(node => getComputedStyle(node).backgroundColor)
  const white = await first(page).evaluate(node => getComputedStyle(node).backgroundColor)
  expect(grey).not.toBe(white)
  await expect(cancelled.locator('xpath=..').getByRole('link', { name: /^Directions to/ })).toHaveCount(0)
  await expect(cancelled.locator('.admin-card-times')).toContainText('13:00')
})

test('a very long name wraps inside the card, away from the price, and nothing goes sideways, even at 320px', async ({ page }) => {
  await openAgenda(page, 320)
  const heading = first(page).locator('.admin-card-heading')
  const name = await box(heading.locator('strong'))
  const price = await box(heading.locator('.admin-card-price'))
  expect(name.right).toBeLessThanOrEqual(price.left)
  expect(name.height, 'it wrapped onto more than one line').toBeGreaterThan(30)
  expect(await noSideways(page)).toBe(true)
  const card = await box(first(page))
  expect(price.right).toBeLessThanOrEqual(card.right)
})

test('Directions sits beside the status at the foot of the card, at least 44px tall, over nothing else', async ({ page }) => {
  await openAgenda(page)
  const wrap = page.locator('.admin-card-wrap.has-directions').first()
  const directions = await box(wrap.getByRole('link', { name: /^Directions to/ }))
  const status = await box(wrap.locator('.admin-status'))
  const card = await box(wrap.locator('.admin-card'))
  expect(directions.height).toBeGreaterThanOrEqual(44)
  expect(directions.bottom).toBeLessThanOrEqual(card.bottom)
  expect(overlap(directions, status)).toBe(false)
  for (const part of ['.admin-card-when', '.admin-card-heading', '.admin-card-meta']) expect(overlap(directions, await box(wrap.locator(part))), part).toBe(false)
  // Level with the status, not above or below it.
  expect(Math.abs((directions.top + directions.bottom) / 2 - (status.top + status.bottom) / 2)).toBeLessThanOrEqual(6)
})

// Every state a booking can be in keeps the same card: time at the top, name and price, treatment and postcode, then its status in words.
const STATES = [
  { status: 'awaiting_cash_approval', payment: 'awaiting_approval', words: 'Awaiting cash approval' },
  { status: 'awaiting_transfer', payment: 'awaiting_transfer', words: 'Awaiting transfer' },
  { status: 'awaiting_payment_verification', payment: 'awaiting_verification', words: 'Awaiting payment verification' },
  { status: 'completed', payment: 'approved', words: 'Completed · Approved' },
  { status: 'no_show', payment: 'approved', words: 'No show · Approved' },
]
for (const state of STATES) {
  test(`a booking that is ${state.words.toLowerCase()} has the same card, with nothing clipped or overlapping`, async ({ page }) => {
    const booking = f.bookings[0]
    await unwrap(f.admin.from('bookings').update({ booking_status: state.status }).eq('id', booking.id))
    await unwrap(f.admin.from('booking_payments').update({ status: state.payment }).eq('booking_id', booking.id))
    await openAgenda(page, 320)
    const card = first(page)
    await expect(card.locator('.admin-status')).toHaveText(state.words)
    for (const part of ['.admin-card-when', '.admin-card-heading', '.admin-card-meta']) await expect(card.locator(part)).toBeVisible()
    expect(await card.locator('.admin-status').evaluate(chip => chip.scrollWidth <= chip.clientWidth + 1)).toBe(true)
    expect(await noSideways(page)).toBe(true)
    const wrap = page.locator('.admin-card-wrap').first()
    const links = wrap.getByRole('link', { name: /^Directions to/ })
    if (await links.count()) expect(overlap(await box(links), await box(wrap.locator('.admin-card-meta')))).toBe(false)
    await page.screenshot({ path: `test-results/card-layout-${state.status}.png`, fullPage: true })
  })
}

test('the Now or Next tag is inside the card, beside its time', async ({ page }) => {
  await openAgenda(page)
  const tag = page.locator('.admin-card .admin-next-tag')
  await expect(tag).toHaveCount(1)
  await expect(tag).toHaveText(/^(Now|Next)$/)
  await expect(tag.locator('xpath=ancestor::*[contains(@class, "admin-card-when")]')).toHaveCount(1)
})

test('blocked time shows its own start and end inside its row, among the cards', async ({ page }) => {
  await unwrap(f.admin.from('calendar_blocks').insert({ group_id: crypto.randomUUID(), kind: 'blocked', title: 'Card layout dentist', date: f.date, start_minutes: 660, end_minutes: 720 }))
  await openAgenda(page)
  const block = page.getByRole('button', { name: /Card layout dentist/ })
  await expect(block).toContainText('11:00 – 12:00')
  const width = (await box(block)).width
  expect(width, 'as wide as the cards').toBeGreaterThanOrEqual((await box(first(page))).width - 2)
})

test('the Day view has the same cards, and its gaps and travel rows say their own times', async ({ page }) => {
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page, '/admin/day')
  await page.getByLabel('Calendar date', { exact: true }).fill(f.date)
  await expect(page.locator('.admin-card')).toHaveCount(2)
  await expect(page.locator('.admin-time')).toHaveCount(0)
  await expect(first(page).locator('.admin-card-times')).toContainText('10:00')
  const rows = page.getByRole('list', { name: 'Day timeline' }).locator('.admin-timeline-entry')
  await expect(rows.first()).toContainText(/\d\d:\d\d – \d\d:\d\d/)
  for (const row of await rows.all()) expect((await box(row)).width).toBeGreaterThan(300)
  expect(await noSideways(page)).toBe(true)
  await page.screenshot({ path: 'test-results/card-layout-day.png', fullPage: true })
})

test("a day's own page lists its bookings as the same cards", async ({ page }) => {
  await openAgenda(page)
  await page.getByRole('button', { name: `Day settings for ${dateLabel(f.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}` }).click()
  await expect(page.getByRole('heading', { name: /^Bookings$/ })).toBeVisible()
  await expect(page.locator('.admin-card')).toHaveCount(2)
  await expect(page.locator('.admin-time')).toHaveCount(0)
  await expect(first(page).locator('.admin-card-times')).toContainText('10:00')
  expect(await noSideways(page)).toBe(true)
})

test('a card works from the keyboard and still opens the booking', async ({ page }) => {
  await openAgenda(page)
  // Tab from the top of the page until a card has the focus, as a keyboard user would.
  for (let step = 0; step < 40 && !(await page.evaluate(() => document.activeElement?.classList.contains('admin-card'))); step++) await page.keyboard.press('Tab')
  const card = page.locator('.admin-card:focus')
  await expect(card).toHaveCount(1)
  const ring = await card.evaluate(node => { const style = getComputedStyle(node); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) } })
  expect(ring.style, 'a visible focus ring').not.toBe('none')
  expect(ring.width).toBeGreaterThanOrEqual(2)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toContainText(f.bookings[0].booking_reference)
})
