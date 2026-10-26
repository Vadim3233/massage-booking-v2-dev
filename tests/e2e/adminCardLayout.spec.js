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
  // These tests are about the cards, so cancelled bookings are asked for here (the Agenda leaves them out unless they are); the default is tested in adminCancelledSwitch.spec.js.
  await page.addInitScript(() => localStorage.setItem('vad-admin-agenda-show-cancelled', '1'))
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
async function openAgenda(page, width = 390, cards = 3) {
  await f.authorize()
  await page.setViewportSize({ width, height: 844 })
  await login(page)
  await expect(page.locator('.admin-card')).toHaveCount(cards)
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
  await expect(first(page).locator('.admin-card-length')).toHaveText('1 person · 60 min')
  // Said in words for a screen reader, not as two numbers with a dash between them.
  await expect(first(page)).toHaveAccessibleName(/10:00 to 11:00/)
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
  await expect(first(page).locator('.admin-card-length')).toHaveText('2 people · 2 × 60 min')
  await expect(first(page).locator('.admin-card-treatment')).toHaveText('2 sessions')
})

test('a cancelled card is grey and quiet, with its name and price struck through, and it has no Directions button', async ({ page }) => {
  await openAgenda(page)
  const cancelled = page.locator('.admin-card.cancelled')
  await expect(cancelled).toHaveCount(1)
  expect(await cancelled.locator('.admin-card-heading strong').evaluate(node => getComputedStyle(node).textDecorationLine)).toContain('line-through')
  expect(await cancelled.locator('.admin-card-price').evaluate(node => getComputedStyle(node).textDecorationLine)).toContain('line-through')
  // Not struck through: when it was, which is still worth reading.
  expect(await cancelled.locator('.admin-card-times').evaluate(node => getComputedStyle(node).textDecorationLine)).not.toContain('line-through')
  const grey = await cancelled.evaluate(node => getComputedStyle(node).backgroundColor)
  const white = await first(page).evaluate(node => getComputedStyle(node).backgroundColor)
  expect(grey).not.toBe(white)
  // The card is a quiet soft grey, never peach: only its status label is peach, and its edge is the terracotta that goes with it.
  const token = name => page.evaluate(variable => { const probe = document.createElement('i'); probe.style.background = `var(${variable})`; document.body.append(probe); const colour = getComputedStyle(probe).backgroundColor; probe.remove(); return colour }, name)
  expect(grey).not.toBe(await token('--cancel-bg'))
  expect(await cancelled.locator('.admin-status').evaluate(node => getComputedStyle(node).backgroundColor)).toBe(await token('--cancel-bg'))
  expect(await cancelled.evaluate(node => getComputedStyle(node, '::before').backgroundColor)).toBe(await token('--cancel-rail'))
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

// The status at the foot of a card: one pill, or the pair of pills (the appointment and its money) as one box.
const statusOf = scope => scope.locator('.admin-card-foot > .admin-status, .admin-card-foot > .admin-status-pair')
test('Directions sits beside the status at the foot of the card, looks 36px tall and is 44px to press, over nothing else', async ({ page }) => {
  await openAgenda(page)
  const wrap = page.locator('.admin-card-wrap.has-directions').first()
  // Each day now says its hours, so the card may start below the fold: it is brought into view before points on screen are pressed.
  await wrap.scrollIntoViewIfNeeded()
  const directions = await box(wrap.getByRole('link', { name: /^Directions to/ }))
  const status = await box(statusOf(wrap))
  const card = await box(wrap.locator('.admin-card'))
  expect(directions.height).toBeGreaterThanOrEqual(36)
  expect(directions.bottom).toBeLessThanOrEqual(card.bottom)
  // Pressing three pixels above or below the pill still presses it, so the target is 44px tall, not just the 36px that shows.
  const centre = (directions.left + directions.right) / 2
  for (const y of [directions.top - 3, directions.bottom + 3]) {
    expect(await page.evaluate(([x, top]) => document.elementFromPoint(x, top)?.closest('a')?.getAttribute('aria-label') ?? '', [centre, y])).toMatch(/^Directions to/)
  }
  expect(overlap(directions, status)).toBe(false)
  for (const part of ['.admin-card-when', '.admin-card-heading', '.admin-card-meta']) expect(overlap(directions, await box(wrap.locator(part))), part).toBe(false)
  // Level with the status, not above or below it.
  expect(Math.abs((directions.top + directions.bottom) / 2 - (status.top + status.bottom) / 2)).toBeLessThanOrEqual(6)
})

// Every state a booking can be in keeps the same card: time at the top, name and price, treatment and postcode, then its status in words.
// The database does not let a confirmed booking be moved straight to a waiting state, so each is made as a new booking at 15:00.
const STATES = [
  { status: 'awaiting_cash_approval', method: 'cash', payment: 'awaiting_approval', words: 'Awaiting cash approval', pills: ['Not confirmed yet', 'Cash to approve'] },
  { status: 'awaiting_transfer', method: 'bank_transfer', payment: 'awaiting_transfer', words: 'Awaiting transfer', pills: ['Not confirmed yet', 'Payment awaited'] },
  { status: 'awaiting_payment_verification', method: 'bank_transfer', payment: 'awaiting_verification', words: 'Awaiting payment verification', pills: ['Not confirmed yet', 'Transfer to check'] },
  { status: 'confirmed', method: 'bank_transfer', payment: 'awaiting_transfer', words: 'Confirmed · Awaiting transfer', pills: ['Confirmed', 'Payment awaited'] },
  { status: 'completed', method: 'bank_transfer', payment: 'paid', words: 'Completed · Paid', pills: ['Completed', 'Paid'] },
  { status: 'no_show', method: 'bank_transfer', payment: 'paid', words: 'No show · Paid', pills: ['No show · Paid'] },
]
for (const state of STATES) {
  test(`a booking that is ${state.words.toLowerCase()} has the same card, with nothing clipped or overlapping`, async ({ page }) => {
    const { id, created_at, updated_at, ...copy } = f.bookings[0]
    void id; void created_at; void updated_at
    const made = await unwrap(f.admin.from('bookings').insert({ ...copy, start_minutes: 900, booking_status: state.status, booking_reference: `STATE-${crypto.randomUUID()}` }).select().single())
    await unwrap(f.admin.from('booking_sessions').insert({ booking_id: made.id, position: 1, service_id: f.ids.service, duration_minutes: 60, service_name_snapshot: 'State session', unit_price_gbp: 85 }))
    await unwrap(f.admin.from('booking_payments').insert({ booking_id: made.id, method: state.method, status: state.payment, amount_gbp: 85, ...(state.payment === 'paid' ? { paid_at: new Date().toISOString() } : {}) }))
    await openAgenda(page, 320, 4)
    const card = page.locator('.admin-card', { hasText: '15:00' })
    await expect(card).toHaveCount(1)
    await expect(card.locator('.admin-status')).toHaveText(state.pills)
    for (const part of ['.admin-card-when', '.admin-card-heading', '.admin-card-meta']) await expect(card.locator(part)).toBeVisible()
    expect(await card.locator('.admin-status').evaluateAll(chips => chips.every(chip => chip.scrollWidth <= chip.clientWidth + 1))).toBe(true)
    expect(await noSideways(page)).toBe(true)
    const wrap = page.locator('.admin-card-wrap', { has: card })
    const links = wrap.getByRole('link', { name: /^Directions to/ })
    if (await links.count()) {
      expect(overlap(await box(links), await box(wrap.locator('.admin-card-meta')))).toBe(false)
      expect(overlap(await box(links), await box(statusOf(wrap)))).toBe(false)
    }
    await card.scrollIntoViewIfNeeded()
    await wrap.screenshot({ path: `test-results/card-layout-${state.status}.png` })
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

// The heading of each day is one line, because it stays pinned at the top while you scroll through the day and every pixel of it is a pixel
// the cards do not get. The notes about special hours or time away sit in a slim strip under it.
const daySection = (page, date) => page.locator('.admin-agenda-day', { has: page.locator(`[id="agenda-${date}"]`) })
const longDate = date => dateLabel(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

test('a day heading is one line: the date, what the day is worth, and an icon that opens its settings', async ({ page }) => {
  await openAgenda(page)
  const day = daySection(page, f.date)
  const heading = day.locator('.admin-agenda-day-heading')
  const bar = await box(heading)
  expect(bar.height, 'one short line').toBeLessThanOrEqual(56)
  const title = await box(heading.locator('h2'))
  const summary = await box(heading.locator('> span'))
  expect(Math.abs((title.top + title.bottom) / 2 - (summary.top + summary.bottom) / 2), 'date and summary level').toBeLessThanOrEqual(4)
  await expect(heading.locator('> span')).toContainText('1 booking')
  // The button is an icon with a name for a screen reader and a tooltip, and 44 by 44 to press.
  const button = day.getByRole('button', { name: `Day settings for ${longDate(f.date)}` })
  await expect(button).toHaveAttribute('title', 'Day settings')
  expect((await button.innerText()).trim()).toBe('')
  const target = await box(button)
  expect(target.width).toBeGreaterThanOrEqual(44)
  expect(target.height).toBeGreaterThanOrEqual(44)
  expect(target.right, 'inside the screen').toBeLessThanOrEqual(390)
  // Pinned while scrolling, and short.
  expect(await heading.evaluate(node => { const style = getComputedStyle(node); return `${style.position} ${style.top}` })).toBe('sticky 0px')
  // The special hours are a slim strip of their own under it.
  const note = day.locator('.admin-agenda-notes li')
  await expect(note).toContainText('Special hours 10:00')
  expect((await box(note)).height).toBeLessThanOrEqual(30)
  await button.click()
  await expect(page).toHaveURL(new RegExp('/admin/day-settings[?]date=' + f.date + '$'))
})

test("today's band and a long summary keep to one tidy heading, even at 320px", async ({ page }) => {
  // A day worth over a million pounds is the worst a summary can be; it wraps inside its own space and never pushes the icon away.
  await unwrap(f.admin.from('bookings').update({ total_gbp: 1234567.89 }).eq('id', f.bookings[0].id))
  await openAgenda(page, 320)
  const heading = daySection(page, f.date).locator('.admin-agenda-day-heading')
  const bar = await box(heading)
  expect(bar.height).toBeLessThanOrEqual(72)
  const button = await box(heading.getByRole('button'))
  expect(button.right).toBeLessThanOrEqual(320)
  expect(await noSideways(page)).toBe(true)
  const today = page.locator('.admin-agenda-day.is-today .admin-agenda-day-heading')
  expect((await box(today)).height).toBeLessThanOrEqual(56)
  await expect(today.locator('h2')).toContainText('Today')
  await page.screenshot({ path: 'test-results/card-layout-heading-320.png', fullPage: false })
})
