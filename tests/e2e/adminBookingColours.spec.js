import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'
import { dateLabel } from '../../src/admin/calendarPresentation.js'

// The Admin's booking boxes are drawn in two families: sage when a booking is settled, sand while it is waiting on money or on the Admin. The same booking has the
// same colours and the same words in the Agenda, the Day view, the day's own page, the booking sheet and a client's list. The fixture's own day (today plus 5) has a
// confirmed booking at 10:00 with its cash approved (settled) and a cancelled one at 13:00; three more are made here, at 15:00, 18:00 and 21:00.
let f
test.beforeEach(async () => { f = await adminFixture(5) })
test.afterEach(async () => { await f?.cleanup() })

const MADE = [
  { at: '15:00', start: 900, status: 'confirmed', method: 'bank_transfer', payment: 'awaiting_transfer', words: 'Confirmed · Awaiting transfer', pills: 'Confirmed | Payment awaited', variant: 'sand', chip: 'wait' },
  { at: '18:00', start: 1080, status: 'awaiting_payment_verification', method: 'bank_transfer', payment: 'awaiting_verification', words: 'Awaiting payment verification', pills: 'Not confirmed yet | Transfer to check', variant: 'sand', chip: 'needs' },
  { at: '21:00', start: 1260, status: 'completed', method: 'bank_transfer', payment: 'paid', words: 'Completed · Paid', pills: 'Completed | Paid', variant: 'completed', chip: 'done' },
]
// On a card and the booking sheet a booking that is going ahead shows two pills, the appointment and its money (`pills`); a client's list keeps
// one pill in words (`words`). A cancelled booking has one pill everywhere.
const SETTLED = { at: '10:00', words: 'Confirmed · Cash approved', pills: 'Confirmed | Cash approved', variant: 'sage', chip: 'ok' }
const CANCELLED = { at: '13:00', words: 'Cancelled', pills: 'Cancelled', variant: 'cancelled', chip: 'cancel' }

async function makeBookings() {
  const { id, created_at, updated_at, ...copy } = f.bookings[0]
  void id; void created_at; void updated_at
  for (const state of MADE) {
    const made = await unwrap(f.admin.from('bookings').insert({ ...copy, start_minutes: state.start, booking_status: state.status, booking_reference: `COLOUR-${crypto.randomUUID()}` }).select().single())
    await unwrap(f.admin.from('booking_sessions').insert({ booking_id: made.id, position: 1, service_id: f.ids.service, duration_minutes: 60, service_name_snapshot: 'Colour session', unit_price_gbp: 85 }))
    await unwrap(f.admin.from('booking_payments').insert({ booking_id: made.id, method: state.method, status: state.payment, amount_gbp: 85, ...(state.payment === 'paid' ? { paid_at: new Date().toISOString() } : {}) }))
  }
}
async function login(page, path) {
  // The Agenda leaves cancelled bookings out unless they are asked for.
  await page.addInitScript(() => localStorage.setItem('vad-admin-agenda-show-cancelled', '1'))
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
// What a colour token is, as the browser says it ("rgb(234, 243, 230)"), so a box is checked against the token and not against a copy of its value.
const token = (page, name) => page.evaluate(variable => {
  const probe = document.createElement('span')
  probe.style.color = `var(${variable})`
  document.body.append(probe)
  const colour = getComputedStyle(probe).color
  probe.remove()
  return colour
}, name)
// A card's pills: their words, joined with " | ", and their colours. The pill in the card's own colour family is the one checked against it
// (a confirmed booking still waiting for money has a sage "Confirmed" pill and a sand "Payment awaited" pill on a sand card).
const look = card => card.evaluate(node => {
  const chips = [...node.querySelectorAll('.chip')]
  return {
    variant: node.dataset.variant, background: getComputedStyle(node).backgroundColor, ink: getComputedStyle(node.querySelector('.admin-card-times')).color,
    words: chips.map(chip => chip.textContent).join(' | '), chips: chips.map(chip => ({ chipBackground: getComputedStyle(chip).backgroundColor, chipInk: getComputedStyle(chip).color })),
  }
})
const inFamily = (seen, colours) => seen.chips.some(chip => chip.chipBackground === colours.chipBackground && chip.chipInk === colours.chipInk)
const cardAt = (page, at) => page.locator('.admin-card', { hasText: at }).first()
const EXPECTED = page => async () => ({
  sage: { background: await token(page, '--sage-bg'), ink: await token(page, '--sage-ink'), chipBackground: await token(page, '--sage-chip'), chipInk: await token(page, '--sage-ink') },
  sand: { background: await token(page, '--sand-bg'), ink: await token(page, '--sand-ink'), chipBackground: await token(page, '--sand-chip'), chipInk: await token(page, '--sand-ink') },
  completed: { background: await token(page, '--surface'), chipBackground: await token(page, '--done-bg'), chipInk: await token(page, '--done-ink') },
  cancelled: { background: await token(page, '--cancel-surface'), chipBackground: await token(page, '--cancel-bg'), chipInk: await token(page, '--cancel-ink') },
})

test('a settled booking is sage and one waiting on money is sand, in the words of what is waited for', async ({ page }) => {
  await makeBookings()
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page, '/admin/agenda')
  await expect(cardAt(page, '21:00')).toBeVisible()
  const colours = await EXPECTED(page)()
  for (const state of [SETTLED, ...MADE, CANCELLED]) {
    const seen = await look(cardAt(page, state.at))
    expect(seen.variant, state.words).toBe(state.variant)
    expect(seen.words, state.words).toBe(state.pills)
    const { chipBackground, chipInk, ...card } = colours[state.variant]
    expect(seen, state.words).toMatchObject(card)
    expect(inFamily(seen, { chipBackground, chipInk }), state.words).toBe(true)
  }
  // Both kinds of waiting are the same sand, and a booking that is settled is not.
  const waiting = await look(cardAt(page, '15:00'))
  const asked = await look(cardAt(page, '18:00'))
  expect(waiting.background).toBe(asked.background)
  expect(waiting.background).not.toBe((await look(cardAt(page, '10:00'))).background)
  await page.screenshot({ path: 'test-results/booking-colours-agenda.png', fullPage: true })
})

test('a card keeps its tint, a little deeper, when it is hovered, instead of turning white', async ({ page }) => {
  await makeBookings()
  await f.authorize()
  await login(page, '/admin/agenda')
  const sage = await token(page, '--sage-hover')
  const sand = await token(page, '--sand-hover')
  await cardAt(page, '10:00').hover()
  // The colour eases over, so it is read until it has arrived.
  await expect.poll(() => cardAt(page, '10:00').evaluate(node => getComputedStyle(node).backgroundColor)).toBe(sage)
  await cardAt(page, '15:00').hover()
  await expect.poll(() => cardAt(page, '15:00').evaluate(node => getComputedStyle(node).backgroundColor)).toBe(sand)
})

test('the same booking looks the same in the Agenda, the Day view and the day\'s own page', async ({ page }) => {
  await makeBookings()
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  const views = {}
  const collect = async name => {
    views[name] = {}
    for (const state of [SETTLED, ...MADE, CANCELLED]) views[name][state.at] = await look(cardAt(page, state.at))
  }
  await login(page, '/admin/agenda')
  await expect(cardAt(page, '21:00')).toBeVisible()
  await collect('agenda')
  await page.goto('/admin/day')
  await page.getByLabel('Calendar date', { exact: true }).fill(f.date)
  await expect(cardAt(page, '21:00')).toBeVisible()
  await collect('day')
  await page.goto('/admin/agenda')
  await page.getByRole('button', { name: `Day settings for ${dateLabel(f.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}` }).click()
  await expect(page.getByRole('heading', { name: /^Bookings$/ })).toBeVisible()
  await expect(cardAt(page, '21:00')).toBeVisible()
  await collect('settings')
  expect(views.day).toEqual(views.agenda)
  expect(views.settings).toEqual(views.agenda)
})

test('the booking sheet and a client\'s list use the same words and colours as the card', async ({ page }) => {
  await makeBookings()
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page, '/admin/agenda')
  const colours = await EXPECTED(page)()
  const card = cardAt(page, '15:00')
  const onCard = await look(card)
  await card.click()
  const chips = page.getByRole('dialog').locator('.admin-details-client .admin-status')
  await expect(chips).toHaveText(onCard.words.split(' | '))
  expect(await chips.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor))).toEqual(onCard.chips.map(chip => chip.chipBackground))
  await page.getByRole('button', { name: 'Close details' }).click()
  await page.goto(`/admin/clients/${f.bookings[0].client_id}`)
  for (const state of [SETTLED, ...MADE]) {
    const row = page.locator('.admin-client-bookings li', { hasText: state.at }).first()
    await expect(row.locator('.chip')).toHaveText(state.words)
    expect(await row.locator('button').getAttribute('data-variant')).toBe(state.variant)
    expect(await row.locator('.chip').evaluate(node => getComputedStyle(node).backgroundColor), state.words).toBe(colours[state.variant].chipBackground)
  }
  const sandRow = page.locator('.admin-client-bookings li', { hasText: '15:00' }).first().locator('button')
  expect(await sandRow.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(colours.sand.background)
  await page.screenshot({ path: 'test-results/booking-colours-client.png', fullPage: true })
})

test('To check lists what is waiting on money or on the Admin in sand', async ({ page }) => {
  await makeBookings()
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page, '/admin/review')
  const sand = await token(page, '--sand-bg')
  const items = page.locator('.admin-review-item')
  await expect.poll(() => items.count()).toBeGreaterThan(0)
  for (const item of await items.all()) {
    expect(await item.getAttribute('data-variant')).toBe('sand')
    expect(await item.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(sand)
  }
  await page.screenshot({ path: 'test-results/booking-colours-review.png', fullPage: true })
})
