import { test, expect } from '@playwright/test'
import { localFixture } from '../localSupabase.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'

// The line under "Confirmation email:" that says which address my emails come from and where to look for one that has not come. The confirmation page
// right after booking is checked in booking.spec.js (and the payment step, which has not got it); this is the page opened later, from Your bookings
// or from the private link in an email.
const SENDER = 'hello@book.vadmassage.com'
const HINT = `My emails come from ${SENDER}. Can't find one? Look in your spam folder and press “Not spam”.`
let fixture
test.beforeEach(async () => { fixture = await localFixture(33) })
test.afterEach(async () => { await fixture?.cleanup() })

// A confirmed booking for the fixture's client, with this address on it (none at all when `email` is null).
async function booked(email) {
  const booking = await unwrap(fixture.admin.from('bookings').insert({
    client_id: fixture.profile.client_id, service_area_id: fixture.ids.area, date: fixture.date, start_minutes: 600, treatment_duration_minutes: 60, booking_status: 'confirmed',
    source_channel: 'web', address_line_1_snapshot: '10 Browser Street', city_snapshot: 'London', postcode_snapshot: 'SW1A1AA', service_area_name_snapshot: 'Integration area',
    service_subtotal_gbp: 85, total_gbp: 85, booking_email_snapshot: email, booking_reference: `EMAILHINT-${crypto.randomUUID()}`,
  }).select().single())
  await unwrap(fixture.admin.from('booking_sessions').insert({ booking_id: booking.id, position: 1, service_id: fixture.ids.service, duration_minutes: 60, service_name_snapshot: 'Massage', unit_price_gbp: 85 }))
  await unwrap(fixture.admin.from('booking_payments').insert({ booking_id: booking.id, method: 'cash', status: 'approved', amount_gbp: 85 }))
  return booking
}

async function signedIn(page, path) {
  await page.goto(path)
  await page.getByLabel('Email address', { exact: true }).fill(fixture.email)
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your appointment is confirmed', level: 1 })).toBeVisible()
}
const summary = page => page.getByRole('region', { name: 'Appointment summary' })

test('the booking page says where the emails come from and where to look for one, right under the email address', async ({ page }) => {
  const booking = await booked(fixture.email)
  await page.setViewportSize({ width: 390, height: 844 })
  await signedIn(page, `/account?booking=${booking.id}`)
  const hint = summary(page).locator('.summary-hint')
  await expect(hint).toHaveText(HINT)
  await expect(hint.locator('strong')).toHaveText(SENDER)
  await expect(summary(page)).toContainText(`Confirmation email: ${fixture.email}`)
  // It sits directly under the address it is about, and above the treatments.
  const email = await summary(page).locator('.summary-line', { hasText: 'Confirmation email:' }).boundingBox()
  const line = await hint.boundingBox()
  const treatments = await summary(page).locator('.summary-sessions').boundingBox()
  expect(line.y).toBeGreaterThanOrEqual(email.y + email.height - 1)
  expect(line.y - (email.y + email.height), 'close under the address').toBeLessThanOrEqual(8)
  expect(line.y + line.height).toBeLessThanOrEqual(treatments.y)
  // It is not a link or a button: the address is there to be read, and the page has no new thing to press.
  await expect(hint.locator('a, button')).toHaveCount(0)
})

test('the line is readable and fits a phone and a very small phone', async ({ page }) => {
  const booking = await booked(fixture.email)
  await page.setViewportSize({ width: 390, height: 844 })
  await signedIn(page, `/account?booking=${booking.id}`)
  const hint = summary(page).locator('.summary-hint')
  await expect(hint).toBeVisible()
  // The strength of its colours on the white card, by the WCAG formula: the grey sentence and the darker address in it.
  const ratio = locator => locator.evaluate(element => {
    const parse = value => value.match(/[\d.]+/g).map(Number)
    const luminance = ([r, g, b]) => { const f = c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
    let behind = element
    while (behind.parentElement && parse(getComputedStyle(behind).backgroundColor)[3] === 0) behind = behind.parentElement
    const text = luminance(parse(getComputedStyle(element).color)); const back = luminance(parse(getComputedStyle(behind).backgroundColor))
    return (Math.max(text, back) + 0.05) / (Math.min(text, back) + 0.05)
  })
  expect(await ratio(hint)).toBeGreaterThanOrEqual(4.5)
  expect(await ratio(hint.locator('strong'))).toBeGreaterThanOrEqual(4.5)
  expect(Number.parseFloat(await hint.evaluate(element => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(13)
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no sideways scrolling at ${width}px`).toBe(true)
    const box = await hint.boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width)
  }
})

test('the same line is on the page opened from the private link in an email, with no sign-in', async ({ page }) => {
  const booking = await booked(fixture.email)
  const code = await unwrap(fixture.admin.rpc('mint_booking_access_token', { p_booking_id: booking.id }))
  await page.goto(`/account?booking=${booking.id}#key=${code}`)
  await expect(page.getByRole('heading', { name: 'Your appointment is confirmed', level: 1 })).toBeVisible()
  await expect(page.getByText('Sign in to see your bookings')).toHaveCount(0)
  await expect(summary(page).locator('.summary-hint')).toHaveText(HINT)
})

test('a booking with no email address says to contact Vad, and has no line about emails that cannot be sent', async ({ page }) => {
  const booking = await booked(null)
  await signedIn(page, `/account?booking=${booking.id}`)
  await expect(summary(page)).toContainText('Confirmation email: Please contact Vad to confirm your email')
  await expect(page.locator('.summary-hint')).toHaveCount(0)
  await expect(page.getByText('spam folder')).toHaveCount(0)
})
