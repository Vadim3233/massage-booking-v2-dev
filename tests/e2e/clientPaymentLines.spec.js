import { test, expect } from '@playwright/test'
import { localFixture } from '../localSupabase.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'
import { londonDate } from '../../src/client/booking/bookingDraft.js'

// Under each booking in Your bookings there is one quiet line on where its money stands: what it comes to and whether that is paid, still to
// pay or to be paid in cash, and after a cancellation a refund on its way or a late fee that is due. Each booking below has a time of its own,
// so its tile can be found; the days are counted from today, so the Coming up and Earlier lists both have some.
let fixture
test.beforeEach(async () => { fixture = await localFixture(29) })
test.afterEach(async () => {
  const mine = await unwrap(fixture.admin.from('bookings').select('id').like('booking_reference', 'PAYLINES-%'))
  if (mine.length) {
    const events = await unwrap(fixture.admin.from('event_outbox').select('id').in('aggregate_id', mine.map(booking => booking.id)))
    if (events.length) await unwrap(fixture.admin.from('notification_deliveries').delete().in('event_id', events.map(event => event.id)))
    await unwrap(fixture.admin.from('event_outbox').delete().in('aggregate_id', mine.map(booking => booking.id)))
  }
  await unwrap(fixture.admin.from('bookings').delete().like('booking_reference', 'PAYLINES-%'))
  await fixture?.cleanup()
})

const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
const FEE = { late_fee_status: 'due', late_fee_standard_gbp: 20, late_fee_due_gbp: 20 }
// `line` is what the tile says under the treatment (null: nothing), `tone` its colour (`ok`, `due` or none).
const SCENES = [
  { time: 540, day: 6, status: 'confirmed', method: 'bank_transfer', pay: 'paid', price: 90, line: '£90.00 · Paid', tone: 'ok' },
  { time: 600, day: 9, status: 'confirmed', method: 'cash', pay: 'approved', price: 125, line: '£125.00 · Pay in cash at your appointment', tone: 'due' },
  { time: 660, day: 12, status: 'awaiting_transfer', method: 'bank_transfer', pay: 'awaiting_transfer', price: 90, line: '£90.00 to pay by bank transfer', tone: 'due' },
  { time: 720, day: 14, status: 'awaiting_payment_verification', method: 'bank_transfer', pay: 'awaiting_verification', price: 90, line: '£90.00', tone: '' },
  { time: 780, day: 3, status: 'awaiting_cash_approval', method: 'cash', pay: 'awaiting_approval', price: 60, line: '£60.00 · Cash', tone: '' },
  { time: 840, day: -3, status: 'cancelled', method: 'bank_transfer', pay: 'paid', price: 90, refund: 90, line: 'Refund of £90.00 on its way', tone: 'due' },
  { time: 900, day: -6, status: 'cancelled', method: 'bank_transfer', pay: 'paid', price: 85, fee: FEE, line: 'Late fee of £20.00 due', tone: 'due' },
  { time: 960, day: -9, status: 'cancelled', method: 'bank_transfer', pay: 'refunded', price: 90, line: 'Refunded', tone: '' },
  { time: 1020, day: -12, status: 'confirmed', method: 'bank_transfer', pay: 'paid', price: 125, line: '£125.00 · Paid', tone: 'ok' },
  { time: 1080, day: -15, status: 'cancelled', method: 'bank_transfer', pay: 'rejected', price: 90, line: null },
  { time: 1140, day: -18, status: 'confirmed', method: 'cash', pay: 'approved', price: 100, line: '£100.00 · Cash', tone: '' },
  { time: 1200, day: -21, status: 'cancelled', method: 'bank_transfer', pay: 'paid', price: 85, refund: 40, fee: FEE, line: 'Refund of £40.00 on its way · Late fee of £20.00 due', tone: 'due' },
  { time: 1260, day: -24, status: 'cancelled', method: 'bank_transfer', pay: 'paid', price: 85, refund: 0, line: null },
]

async function seed() {
  const base = {
    client_id: fixture.profile.client_id, service_area_id: fixture.ids.area, source_channel: 'web', address_line_1_snapshot: '12 Edith Road', city_snapshot: 'London', postcode_snapshot: 'SW1A1AA',
    service_area_name_snapshot: 'Test area', booking_email_snapshot: fixture.email,
  }
  for (const scene of SCENES) {
    const booking = await unwrap(fixture.admin.from('bookings').insert({
      ...base, date: londonDate(scene.day), start_minutes: scene.time, treatment_duration_minutes: 60, booking_status: scene.status, total_gbp: scene.price, service_subtotal_gbp: scene.price,
      booking_reference: `PAYLINES-${crypto.randomUUID()}`,
      ...(scene.refund !== undefined ? { refund_due_gbp: scene.refund } : {}),
      ...(scene.fee || {}),
      ...(scene.status === 'cancelled' ? { cancelled_at: new Date().toISOString(), cancelled_by_actor_type: 'client' } : {}),
    }).select().single())
    await unwrap(fixture.admin.from('booking_sessions').insert({ booking_id: booking.id, position: 1, service_id: fixture.ids.service, duration_minutes: 60, service_name_snapshot: 'Massage', unit_price_gbp: scene.price }))
    await unwrap(fixture.admin.from('booking_payments').insert({ booking_id: booking.id, method: scene.method, status: scene.pay, amount_gbp: scene.price, ...(scene.pay === 'paid' ? { paid_at: new Date().toISOString() } : {}) }))
  }
}
async function signIn(page) {
  await page.goto('/account')
  await page.getByLabel('Email address', { exact: true }).fill(fixture.email)
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your bookings', level: 1 })).toBeVisible()
}
const tileAt = (page, minutes) => page.locator('.account-booking').filter({ has: page.locator('.account-when', { hasText: new RegExp(` · ${clock(minutes)}$`) }) })

test('each booking says where its money stands, and one with nothing to say has no line', async ({ page }) => {
  await seed()
  await signIn(page)
  await expect(page.locator('.account-booking')).toHaveCount(SCENES.length)
  for (const scene of SCENES) {
    const tile = tileAt(page, scene.time)
    await expect(tile).toHaveCount(1)
    if (scene.line === null) { await expect(tile.locator('.account-pay')).toHaveCount(0); continue }
    await expect(tile.locator('.account-pay')).toHaveText(scene.line)
    await expect(tile.locator('.account-pay')).toHaveClass(scene.tone ? new RegExp(`account-pay--${scene.tone}$`) : /^account-pay$/)
  }
  // The status still comes last and the tile still opens that booking.
  await expect(tileAt(page, 540).locator('.chip')).toHaveText('Confirmed')
  await expect(tileAt(page, 660).locator('.chip')).toHaveText('Waiting for your bank transfer')
  await tileAt(page, 840).click()
  await expect(page.getByRole('heading', { name: 'Your appointment is cancelled' })).toBeVisible()
})

test('the line is readable: strong enough colours, and it fits a 320px phone with the longest wording', async ({ page }) => {
  await seed()
  await page.setViewportSize({ width: 320, height: 800 })
  await signIn(page)
  await expect(page.locator('.account-booking')).toHaveCount(SCENES.length)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  // WCAG contrast of the line against the tile it sits on, for the three colours it comes in.
  const ratio = await page.evaluate(() => {
    const channels = value => value.match(/[\d.]+/g).slice(0, 3).map(Number)
    const luminance = ([r, g, b]) => { const f = c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
    const out = {}
    for (const [key, selector] of [['ok', '.account-pay--ok'], ['due', '.account-pay--due'], ['plain', '.account-pay:not(.account-pay--ok):not(.account-pay--due)']]) {
      const line = document.querySelector(selector)
      const tile = line.closest('.account-booking')
      const a = luminance(channels(getComputedStyle(line).color)); const b = luminance(channels(getComputedStyle(tile).backgroundColor))
      out[key] = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    }
    return out
  })
  for (const key of ['ok', 'due', 'plain']) expect(ratio[key], `${key} line contrast`).toBeGreaterThanOrEqual(4.5)
})
