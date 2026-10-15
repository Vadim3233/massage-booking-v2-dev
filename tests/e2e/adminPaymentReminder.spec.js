import { test, expect } from '@playwright/test'
import { paymentReviewFixture } from '../paymentReviewFixture.js'
import { shiftDate } from '../../src/admin/calendarPresentation.js'
import { fingerprint, londonDateOf, londonInstant } from '../../src/admin/paymentReminders.js'

// The Needs you box at the top of the Agenda is one short header and a row for each payment, and "Not yet" puts a payment off until a time the
// Admin chooses, without touching the booking or telling the client. The fixture has a bank transfer the client says is paid (Verify) and a cash
// request (Approve), both for a client whose name is 108 letters long.
let f
const KEY = 'vad-admin-payment-reminders'
test.beforeEach(async () => { f = await paymentReviewFixture() })
test.afterEach(async () => { await f?.cleanup() })

async function login(page, path = '/admin/agenda') {
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
async function open(page, width = 390) {
  await f.authorize()
  await page.setViewportSize({ width, height: 844 })
  await login(page)
  await expect(page.locator('.admin-tocheck li')).toHaveCount(2)
}
const nav = page => page.getByRole('navigation', { name: 'Admin navigation' })
const box = page => page.locator('.admin-tocheck')
// The row of the bank transfer (it has Verify) and of the cash request (it has Approve).
const transferRow = page => box(page).locator('li').filter({ has: page.getByRole('button', { name: /^Verify payment, / }) })
const cashRow = page => box(page).locator('li').filter({ has: page.getByRole('button', { name: /^Approve, / }) })
const stored = page => page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{}'), KEY)
const noSideways = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
const bounds = locator => locator.evaluate(node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } })
async function state(id) {
  const booking = (await f.admin.from('bookings').select('booking_status,updated_at').eq('id', id).single()).data
  const payment = (await f.admin.from('booking_payments').select('status,updated_at').eq('booking_id', id).single()).data
  const events = (await f.admin.from('event_outbox').select('id', { count: 'exact', head: true }).eq('aggregate_id', id)).count
  return { booking, payment, events }
}
async function putOff(page, row, choice) {
  await row.getByRole('button', { name: /^Not yet, / }).click()
  await page.locator('dialog.admin-confirm').getByRole('button', { name: choice }).click()
  await expect(page.locator('dialog.admin-confirm')).toHaveCount(0)
}
const tomorrow = () => shiftDate(londonDateOf(Date.now()), 1)

test('the box is one short header and a row for each payment, with Not yet beside the button that settles it', async ({ page }) => {
  // A name like the ones clients really have (the fixture's own is 108 letters, tried in the next test).
  await f.admin.from('clients').update({ first_name: 'Noor', last_name: 'Rahman' }).eq('id', f.bookings[0].client_id)
  await open(page)
  await expect(box(page).getByRole('heading', { level: 2 })).toHaveText('Needs you · 2 payments to check · £170.00')
  await expect(box(page).locator('.eyebrow')).toHaveCount(0)
  // It used to be about 275px tall for two payments.
  expect((await bounds(box(page))).height).toBeLessThanOrEqual(190)
  for (const row of [transferRow(page), cashRow(page)]) {
    const later = row.getByRole('button', { name: /^Not yet, / })
    const settle = row.getByRole('button', { name: /^(Verify payment|Approve), / })
    const a = await bounds(later)
    const b = await bounds(settle)
    expect(a.height).toBeGreaterThanOrEqual(44)
    expect(b.height).toBeGreaterThanOrEqual(44)
    expect(a.right, 'Not yet comes first, then the button that settles it').toBeLessThanOrEqual(b.left)
    expect(Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2)).toBeLessThanOrEqual(2)
    expect(b.right).toBeLessThanOrEqual((await bounds(box(page))).right)
  }
  expect(await noSideways(page)).toBe(true)
  await page.screenshot({ path: 'test-results/needs-you-box-390.png' })
})

test('a very long name wraps inside its row and never pushes the buttons out', async ({ page }) => {
  await open(page)
  const frame = await bounds(box(page))
  for (const button of await box(page).getByRole('button').all()) {
    const b = await bounds(button)
    expect(b.left).toBeGreaterThanOrEqual(frame.left)
    expect(b.right).toBeLessThanOrEqual(frame.right)
  }
  expect(await noSideways(page)).toBe(true)
})

test('on a very narrow phone the buttons drop under the words instead of squeezing them', async ({ page }) => {
  await open(page, 320)
  const frame = await bounds(box(page))
  for (const button of await box(page).getByRole('button').all()) {
    const b = await bounds(button)
    expect(b.height).toBeGreaterThanOrEqual(44)
    expect(b.left).toBeGreaterThanOrEqual(frame.left)
    expect(b.right).toBeLessThanOrEqual(frame.right)
  }
  expect(await noSideways(page)).toBe(true)
  await page.screenshot({ path: 'test-results/needs-you-box-320.png' })
})

test('Not yet asks when to be reminded, and going back sets nothing', async ({ page }) => {
  await open(page)
  const before = await state(f.bookings[0].id)
  await transferRow(page).getByRole('button', { name: /^Not yet, / }).click()
  const sheet = page.locator('dialog.admin-confirm')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('heading', { name: 'Remind me later?' })).toBeVisible()
  await expect(sheet).toContainText('The booking keeps its time and the client is told nothing')
  await expect(sheet.getByRole('button')).toHaveText([/^In 3 hours · \d\d:\d\d$/, /^Tomorrow morning · \w{3} \d+ \w{3}, 09:00$/, /^The day before · \w{3} \d+ \w{3}, 09:00$/, 'Go back'])
  await sheet.getByRole('button', { name: 'Go back' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(box(page).locator('li')).toHaveCount(2)
  expect(await stored(page)).toEqual({})
  expect(await state(f.bookings[0].id)).toEqual(before)
})

test('tomorrow morning puts a payment away, and nothing about the booking changes', async ({ page }) => {
  await open(page)
  const before = [await state(f.bookings[0].id), await state(f.bookings[1].id)]
  await putOff(page, transferRow(page), /^Tomorrow morning/)
  await expect(box(page).locator('li')).toHaveCount(1)
  await expect(box(page).getByRole('heading', { level: 2 })).toHaveText('Needs you · 1 payment to check · £85.00')
  await expect(nav(page).getByLabel('1 to check')).toBeVisible()
  await expect(page.locator('.toast-host')).toContainText('Reminder set')
  await expect(page.locator('.toast-host')).toContainText('back tomorrow, 09:00')
  // Remembered on this device for the morning, in London time.
  const saved = await stored(page)
  expect(Object.keys(saved)).toEqual([f.bookings[0].id])
  expect(saved[f.bookings[0].id].until).toBe(londonInstant(tomorrow(), 9 * 60))
  // The booking, its payment and the messages to the client are exactly as they were.
  expect([await state(f.bookings[0].id), await state(f.bookings[1].id)]).toEqual(before)
  await page.screenshot({ path: 'test-results/needs-you-box-after.png' })
})

test('the payment waits on the To check page with its reminder, and Check now brings it back', async ({ page }) => {
  await open(page)
  await putOff(page, transferRow(page), /^Tomorrow morning/)
  await nav(page).getByRole('link', { name: /^To check/ }).click()
  const card = page.locator('.admin-review-item').filter({ hasText: f.bookings[0].booking_reference })
  await expect(card.locator('.admin-status')).toHaveText('Reminder set · back tomorrow, 09:00')
  await expect(page.locator('.admin-review-summary')).toContainText('1 needs you')
  await expect(page.locator('.admin-review-summary')).toContainText('1 reminder set')
  // It can still be settled from here, for the day the money turns up early.
  await expect(card.getByRole('button', { name: 'Verify payment', exact: true })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Cancel unpaid booking', exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/needs-you-to-check.png', fullPage: true })
  await card.getByRole('button', { name: 'Check now', exact: true }).click()
  await expect(card.locator('.admin-status')).toHaveText('Bank transfer to verify')
  await expect(card.getByRole('button', { name: 'Not yet', exact: true })).toBeVisible()
  expect(await stored(page)).toEqual({})
  await expect(nav(page).getByLabel('2 to check')).toBeVisible()
})

test('a reminder survives a reload, and the payment can still be verified while it is put off', async ({ page }) => {
  await open(page)
  await putOff(page, transferRow(page), /^The day before/)
  await page.reload()
  await expect(box(page).locator('li')).toHaveCount(1)
  await expect(nav(page).getByLabel('1 to check')).toBeVisible()
  await nav(page).getByRole('link', { name: /^To check/ }).click()
  const card = page.locator('.admin-review-item').filter({ hasText: f.bookings[0].booking_reference })
  await card.getByRole('button', { name: 'Verify payment', exact: true }).click()
  await page.locator('dialog.admin-confirm').getByRole('button', { name: /^Yes, / }).click()
  await expect(card).toHaveCount(0)
  expect((await f.admin.from('booking_payments').select('status').eq('booking_id', f.bookings[0].id).single()).data.status).toBe('paid')
})

test('Undo in the message brings the payment straight back', async ({ page }) => {
  await open(page)
  await putOff(page, cashRow(page), /^In 3 hours/)
  await expect(box(page).locator('li')).toHaveCount(1)
  await page.locator('.toast-host').getByRole('button', { name: 'Undo' }).click()
  await expect(box(page).locator('li')).toHaveCount(2)
  expect(await stored(page)).toEqual({})
})

test('a reminder ends by itself when its time comes', async ({ page }) => {
  const booking = (await f.admin.from('bookings').select('updated_at').eq('id', f.bookings[0].id).single()).data
  const payment = (await f.admin.from('booking_payments').select('updated_at').eq('booking_id', f.bookings[0].id).single()).data
  const seen = fingerprint({ updated_at: booking.updated_at, booking_payments: { updated_at: payment.updated_at } })
  await page.clock.install()
  // Remembered on this device before the page opens, due in forty seconds.
  await page.addInitScript(([key, id, mark]) => localStorage.setItem(key, JSON.stringify({ [id]: { until: Date.now() + 40000, seen: mark } })), [KEY, f.bookings[0].id, seen])
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await expect(box(page).locator('li')).toHaveCount(1)
  await page.clock.fastForward(45000)
  await expect(box(page).locator('li')).toHaveCount(2)
  await expect(nav(page).getByLabel('2 to check')).toBeVisible()
})

test('a change to the booking ends the reminder at once', async ({ page }) => {
  await open(page)
  await putOff(page, transferRow(page), /^Tomorrow morning/)
  await expect(box(page).locator('li')).toHaveCount(1)
  // The client says more, or the Admin edits the booking elsewhere: it has changed since the reminder was set.
  await f.admin.from('bookings').update({ client_note: 'Changed after the reminder was set' }).eq('id', f.bookings[0].id)
  await page.reload()
  await expect(box(page).locator('li')).toHaveCount(2)
})

test('a cash request can still be approved straight from the box', async ({ page }) => {
  await open(page)
  await cashRow(page).getByRole('button', { name: /^Approve, / }).click()
  await page.locator('dialog.admin-confirm').getByRole('button', { name: /^Yes, / }).click()
  await expect(box(page).locator('li')).toHaveCount(1)
  expect((await f.admin.from('booking_payments').select('status').eq('booking_id', f.bookings[1].id).single()).data.status).toBe('approved')
})

test('with the keyboard: Escape closes the sheet and returns to Not yet, and a choice moves focus on to the heading', async ({ page }) => {
  await open(page)
  const later = transferRow(page).getByRole('button', { name: /^Not yet, / })
  await later.focus()
  await page.keyboard.press('Enter')
  const sheet = page.locator('dialog.admin-confirm')
  await expect(sheet).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(later).toBeFocused()
  expect(await stored(page)).toEqual({})
  // The first choice has the focus when the sheet opens; pressing it sets the reminder.
  await page.keyboard.press('Enter')
  await expect(sheet.getByRole('button', { name: /^In 3 hours/ })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(box(page).locator('li')).toHaveCount(1)
  await expect(box(page).getByRole('heading', { level: 2 })).toBeFocused()
  // Putting off the last one takes the whole box away, and focus goes to the page's own heading.
  await cashRow(page).getByRole('button', { name: /^Not yet, / }).focus()
  await page.keyboard.press('Enter')
  await expect(sheet.getByRole('button', { name: /^In 3 hours/ })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(box(page)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Agenda', exact: true })).toBeFocused()
})

test('the sheet rises from the bottom of a 320px phone and fits it', async ({ page }) => {
  await open(page, 320)
  await transferRow(page).getByRole('button', { name: /^Not yet, / }).click()
  const sheet = page.locator('dialog.admin-confirm')
  await expect(sheet).toBeVisible()
  const frame = await bounds(sheet)
  expect(frame.left).toBeGreaterThanOrEqual(0)
  expect(frame.right).toBeLessThanOrEqual(320)
  expect(frame.bottom, 'sits on the bottom edge').toBeGreaterThanOrEqual(843)
  expect(await sheet.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
  for (const button of await sheet.getByRole('button').all()) expect((await bounds(button)).height).toBeGreaterThanOrEqual(44)
  await page.screenshot({ path: 'test-results/needs-you-sheet-320.png' })
})
