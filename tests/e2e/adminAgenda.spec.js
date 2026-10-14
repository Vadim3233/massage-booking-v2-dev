import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'
import { dateLabel, shiftDate, today } from '../../src/admin/calendarPresentation.js'

let f
const undo = []
test.beforeEach(async () => { f = await adminFixture(5) })
test.afterEach(async () => { for (const step of undo.splice(0).reverse()) await step(); await f?.cleanup() })

async function login(page) {
  await page.goto('/admin/agenda')
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

test('Agenda lists bookings across days and returns to the same view after details', async ({ page }) => {
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)

  await expect(page).toHaveURL(/\/admin\/agenda$/)
  await expect(page.getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Calendar views' }).getByRole('link', { name: 'Agenda', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('navigation', { name: 'Admin navigation' }).getByRole('link', { name: 'Calendar', exact: true })).toHaveAttribute('aria-current', 'page')

  // Today is always on the page as a fixed point, even when nothing is booked; the other days are the ones with bookings.
  await expect(page.locator('.admin-agenda-day.is-today')).toHaveCount(1)
  await expect(page.locator('.admin-agenda-day:has(.admin-card)')).toHaveCount(2)
  await expect(page.locator('.admin-card')).toHaveCount(3)
  await expect(page.locator('.admin-card.cancelled')).toHaveCount(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  await page.locator('.admin-card').first().click()
  await expect(page.getByRole('dialog')).toContainText(f.bookings[0].booking_reference)
  await page.getByRole('button', { name: 'Close details' }).click()
  await expect(page).toHaveURL(/\/admin\/agenda$/)
  await expect(page.getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible()

  await page.getByRole('navigation', { name: 'Calendar views' }).getByRole('link', { name: 'Day', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/day$/)
  await expect(page.getByLabel('Calendar date', { exact: true })).toBeVisible()
})

test('opening the Admin and pressing Calendar both show the Agenda, and Day is one tap away', async ({ page }) => {
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/admin')
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible()
  const views = page.getByRole('navigation', { name: 'Calendar views' })
  await views.getByRole('link', { name: 'Day', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/day$/)
  await expect(page.getByLabel('Calendar date', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: /^To check/ }).click()
  await page.getByRole('navigation', { name: 'Admin navigation' }).getByRole('link', { name: 'Calendar', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible()
})

// Someone books while the Admin is in another app (her banking app, WhatsApp). Coming back shows it without a tap,
// and the list she was looking at never blanks out while it is read again.
async function bookWhileAway(page) {
  const { id, created_at, updated_at, ...copy } = f.bookings[0]
  void id; void created_at; void updated_at
  await page.evaluate(() => {
    window.__blanked = false
    new MutationObserver(() => { if (document.querySelector('.skeleton-rows')) window.__blanked = true }).observe(document.body, { childList: true, subtree: true })
  })
  await unwrap(f.admin.from('bookings').insert({ ...copy, start_minutes: 900, booking_reference: `LATE-${crypto.randomUUID()}` }))
  // Coming back within a few seconds is not worth another read; a real absence is.
  await page.waitForTimeout(5300)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
}

test('the Agenda shows a booking made while the Admin was away, without blanking out', async ({ page }) => {
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await expect(page.locator('.admin-card')).toHaveCount(3)
  await bookWhileAway(page)
  await expect(page.locator('.admin-card')).toHaveCount(4)
  expect(await page.evaluate(() => window.__blanked)).toBe(false)
})

test('the Day view shows a booking made while the Admin was away, without blanking out', async ({ page }) => {
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await page.getByRole('navigation', { name: 'Calendar views' }).getByRole('link', { name: 'Day', exact: true }).click()
  await page.getByLabel('Calendar date', { exact: true }).fill(f.date)
  await expect(page.locator('.admin-card')).toHaveCount(2)
  await bookWhileAway(page)
  await expect(page.locator('.admin-card')).toHaveCount(3)
  expect(await page.evaluate(() => window.__blanked)).toBe(false)
})

// A booking made while away, some days after the fixture's day (a later month, for the Agenda that has read on that far).
async function bookLater(daysAhead) {
  const { id, created_at, updated_at, ...copy } = f.bookings[0]
  void id; void created_at; void updated_at
  await unwrap(f.admin.from('bookings').insert({ ...copy, date: shiftDate(f.date, daysAhead), start_minutes: 900, booking_reference: `LATE-${crypto.randomUUID()}` }))
}
// The server says no at once (the database client would otherwise try a lost connection again for several seconds on its own).
const refuse = route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: '22023', message: 'Test failure', details: null, hint: null }) })
async function openAgenda(page) {
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await expect(page.locator('.admin-card')).toHaveCount(3)
}

test('Refresh reads every month on show, not only the first', async ({ page }) => {
  await openAgenda(page)
  // Read on past the first month (the list also does this by itself as its end comes into view).
  await page.getByRole('button', { name: 'Load more upcoming appointments' }).click()
  await expect(page.locator('.admin-agenda-range')).not.toContainText(dateLabel(shiftDate(today(), 30), { day: 'numeric', month: 'short', year: 'numeric' }))
  await bookLater(40)
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.locator('.admin-card')).toHaveCount(4)
})

test('a refresh that fails just after waking is tried once more before anyone is told', async ({ page }) => {
  await openAgenda(page)
  await bookLater(0)
  // Coming back after a real absence reads the Agenda again by itself.
  await page.waitForTimeout(5300)
  // Every read is refused for the first second and a half, as it can be just after a phone wakes; the second try comes later and works.
  const until = Date.now() + 1500
  await page.route('**/rest/v1/bookings?*', route => (Date.now() < until ? refuse(route) : route.continue()))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('.admin-card')).toHaveCount(4, { timeout: 12000 })
  await expect(page.getByText('Could not refresh the agenda just now.')).toHaveCount(0)
})

test('a refresh that keeps failing says so quietly, keeps the list, and Try again works', async ({ page }) => {
  await openAgenda(page)
  let broken = true
  await page.route('**/rest/v1/bookings?*', route => (broken ? refuse(route) : route.continue()))
  // A refresh she asked for herself says so at once; only one nobody asked for is tried again quietly first.
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByText('Could not refresh the agenda just now.')).toBeVisible({ timeout: 1500 })
  await expect(page.getByRole('status').filter({ hasText: 'Could not refresh the agenda just now.' })).toBeVisible()
  await expect(page.locator('.admin-card')).toHaveCount(3)
  broken = false
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByText('Could not refresh the agenda just now.')).toHaveCount(0)
})

test('an appointment still to come has a Directions button of its own beside its status, and a cancelled one has none', async ({ page }) => {
  await openAgenda(page)
  const directions = page.getByRole('link', { name: /^Directions to/ })
  // Two of the three are going ahead (one is cancelled), so two have the way there one tap away.
  await expect(directions).toHaveCount(2)
  const first = directions.first()
  await expect(first).toHaveAttribute('href', /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=.*VeryLongStreet/)
  await expect(first).toHaveAttribute('target', '_blank')
  await expect(first).toHaveAttribute('rel', /noopener/)
  // A long status ("Confirmed · Cash approved") wraps beside the button instead of being clipped by it.
  const clipped = await page.locator('.admin-card-wrap.has-directions .admin-status').evaluateAll(chips => chips.filter(chip => chip.scrollWidth > chip.clientWidth + 1).length)
  expect(clipped).toBe(0)
  // It is a control of its own: pressing it does not also open the booking's details.
  await first.evaluate(link => link.addEventListener('click', event => event.preventDefault()))
  await first.click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // And the card beside it still opens the details.
  await page.locator('.admin-card').first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('the Day view has the same Directions button on an appointment still to come', async ({ page }) => {
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await page.getByRole('navigation', { name: 'Calendar views' }).getByRole('link', { name: 'Day', exact: true }).click()
  await page.getByLabel('Calendar date', { exact: true }).fill(f.date)
  await expect(page.locator('.admin-card')).toHaveCount(2)
  await expect(page.getByRole('link', { name: /^Directions to/ })).toHaveCount(1)
})

// Blocked time and special days, put in for a test and taken out again afterwards.
const daysFrom = (offset, count) => Array.from({ length: count }, (_, index) => shiftDate(today(), offset + index))
function awayRows(dates, changes = {}) {
  const group_id = crypto.randomUUID()
  return dates.map(date => ({ group_id, kind: 'blocked', title: 'Agenda holiday', date, start_minutes: 0, end_minutes: 1440, ...changes }))
}
async function addBlock(rows) {
  await unwrap(f.admin.from('calendar_blocks').insert(rows))
  undo.push(() => f.admin.from('calendar_blocks').delete().eq('group_id', rows[0].group_id))
}
async function addSpecialDay(entry) {
  const before = await unwrap(f.admin.from('working_hours_overrides').select('*').eq('date', entry.date))
  await unwrap(f.admin.from('working_hours_overrides').upsert(entry))
  undo.push(() => before.length ? f.admin.from('working_hours_overrides').upsert(before) : f.admin.from('working_hours_overrides').delete().eq('date', entry.date))
}
const daySection = (page, date) => page.locator('.admin-agenda-day', { has: page.locator(`[id="agenda-${date}"]`) })

test('time away is one banner at its first day, the days inside it are not listed, and pressing it opens the block', async ({ page }) => {
  const holiday = daysFrom(10, 5)
  await addBlock(awayRows(holiday))
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  const banner = page.getByRole('button', { name: /Away · Agenda holiday/ })
  await expect(banner).toHaveCount(1)
  await expect(banner).toContainText('5 days')
  for (const date of holiday) await expect(page.locator(`[id="agenda-${date}"]`)).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await banner.click()
  await expect(page.getByRole('heading', { name: 'Change blocked time' })).toBeVisible()
  await page.getByRole('button', { name: 'Go back' }).click()
  await expect(page.getByRole('heading', { name: 'Change blocked time' })).toHaveCount(0)
})

test('a special day is said under its date, and a day off with nothing booked is a quiet line', async ({ page }) => {
  await addSpecialDay({ date: shiftDate(today(), 20), available: false, start_minutes: null, end_minutes: null, start_mode: 'flexible', fixed_start_minutes: null, note: 'Agenda family day' })
  await f.authorize()
  await login(page)
  // The fixture opens the day of its bookings with its own hours, so that day carries them in words.
  await expect(daySection(page, f.date).locator('.admin-agenda-notes')).toContainText('Special hours 10:00–22:00')
  await expect(page.locator('.admin-agenda-quiet li', { hasText: 'Agenda family day' })).toContainText('Day off')
})

test("a few hours blocked sit among the day's bookings in time order, and open to change", async ({ page }) => {
  await addBlock(awayRows([f.date], { title: 'Agenda dentist', start_minutes: 660, end_minutes: 720 }))
  await f.authorize()
  await login(page)
  const day = daySection(page, f.date)
  await expect(day.getByRole('button', { name: /Agenda dentist/ })).toBeVisible()
  expect(await day.locator('.admin-timeline-row .admin-time').evaluateAll(nodes => nodes.map(node => node.textContent.slice(0, 5)))).toEqual(['10:00', '11:00', '13:00'])
  await day.getByRole('button', { name: /Agenda dentist/ }).click()
  await expect(page.getByRole('heading', { name: 'Change blocked time' })).toBeVisible()
})

test('when today is inside time away, the banner stands above today, which is said to be a day off', async ({ page }) => {
  await addBlock(awayRows(daysFrom(-2, 6)))
  await f.authorize()
  await login(page)
  const banner = page.getByRole('button', { name: /Away · Agenda holiday/ })
  await expect(banner).toHaveCount(1)
  await expect(banner).toContainText('6 days')
  const todaySection = page.locator('.admin-agenda-day.is-today')
  await expect(todaySection).toContainText('A day off.')
  await expect(todaySection.locator('.admin-agenda-notes')).toContainText('Away · Agenda holiday')
  expect((await banner.boundingBox()).y).toBeLessThan((await todaySection.boundingBox()).y)
})

test('Show every day lists every date as a quiet line, works from the keyboard, is remembered, and still fits a 320px phone', async ({ page }) => {
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  const every = page.getByRole('switch', { name: 'Show every day' })
  await expect(every).not.toBeChecked()
  await expect(page.locator('.admin-agenda-quiet li.is-free')).toHaveCount(0)
  await every.focus()
  await page.keyboard.press('Space')
  await expect(every).toBeChecked()
  await expect(page.locator('.admin-agenda-quiet li.is-free').first()).toBeVisible()
  expect(await page.locator('.admin-agenda-quiet li.is-free').count()).toBeGreaterThan(10)
  // Days the usual week does not work are told apart from free days.
  if ((await unwrap(f.admin.from('working_hours').select('weekday').eq('available', false))).length) {
    await expect(page.locator('.admin-agenda-quiet li.is-closed').first()).toContainText('usual day off')
  }
  await page.reload()
  await expect(page.getByRole('switch', { name: 'Show every day' })).toBeChecked()
  await page.setViewportSize({ width: 320, height: 640 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('switch', { name: 'Show every day' }).uncheck()
  await expect(page.locator('.admin-agenda-quiet li.is-free')).toHaveCount(0)
})

test('scrolling to the end of the list reaches time away eleven weeks ahead without pressing Load more', async ({ page }) => {
  await addBlock(awayRows(daysFrom(75, 3), { title: 'Agenda far holiday' }))
  await f.authorize()
  await login(page)
  await expect(page.getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible()
  // The list reads on by itself as its end comes into view, through empty months, as far as there is something to show.
  await page.getByRole('button', { name: 'Load more upcoming appointments' }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', { name: /Away · Agenda far holiday/ })).toBeVisible({ timeout: 20000 })
})
