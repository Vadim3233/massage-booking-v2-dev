import { test, expect } from '@playwright/test'
import { localFixture } from '../localSupabase.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'

let fixture
test.beforeEach(async () => { fixture = await localFixture(25) })
test.afterEach(async ({ page }) => {
  if (fixture && page.url().startsWith('http://127.0.0.1:5174')) fixture.trackKey(await page.evaluate(() => localStorage.getItem('vad-v2-hold-client-v1')))
  await fixture?.cleanup()
})

async function toReview(page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Integration area/ }).click()
  await page.getByRole('button', { name: /Integration massage/ }).click()
  await page.getByRole('button', { name: 'Add 60 minutes', exact: true }).click()
  await page.getByRole('button', { name: 'Add 60 minutes', exact: true }).click()
  await page.getByRole('button', { name: 'Choose date & time' }).click()
  await page.getByLabel('Appointment date').fill(fixture.date)
  await page.getByRole('button', { name: '10:00', exact: true }).click()
  await page.getByRole('button', { name: 'Review booking', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review your booking' })).toBeVisible()
}

async function toDetails(page) {
  await toReview(page)
  await page.getByLabel(/Integration enhancement/).check()
  await page.locator('.preference-group summary').first().click()
  await page.getByRole('button', { name: 'Integration focus', exact: true }).first().click()
  await page.getByLabel('Session notes (optional)').fill('Preserve my note')
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await page.getByLabel('Email address', { exact: true }).fill(fixture.email)
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await page.getByLabel('Street address', { exact: true }).fill('10 Browser Street')
  await page.getByLabel('Postcode', { exact: true }).fill('sw1a1aa')
}

async function toPayment(page) {
  await toDetails(page)
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await expect(page.getByRole('heading', { name: 'One last step' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy payment reference' })).toBeVisible()
  await page.getByLabel('I understand the payment and cancellation terms.').check()
}

test('mobile bank-transfer journey, browser Back, reload and real persisted result', async ({ page }) => {
  const errors = []; page.on('pageerror', (error) => errors.push(error.message))
  await toReview(page)
  await page.getByLabel('Session notes (optional)').fill('Keep this note')
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Choose date and time' })).toBeVisible()
  await page.getByRole('button', { name: 'Review booking', exact: true }).click()
  await expect(page.getByLabel('Session notes (optional)')).toHaveValue('Keep this note')
  await page.reload()
  await expect(page.getByLabel('Session notes (optional)')).toHaveValue('Keep this note')
  await page.getByLabel(/Integration enhancement/).check()
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await page.getByLabel('Email address', { exact: true }).fill(fixture.email)
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByLabel('Street address', { exact: true }).fill('10 Browser Street')
  await page.getByLabel('Postcode', { exact: true }).fill('sw1a1aa')
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await page.getByLabel('I understand the payment and cancellation terms.').check()
  await page.getByRole('button', { name: "I've made the bank transfer" }).click()
  await expect(page.getByRole('heading', { name: "I've received your booking" })).toBeVisible()
  await expect(page.getByText("Payment: Transfer sent — I'll check it shortly", { exact: true })).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: 'Integration massage · 60 minutes' })).toHaveCount(2)
  await page.screenshot({ path: 'test-results/mobile-confirmation.png', fullPage: true })
  await page.reload()
  await expect(page.getByText("Payment: Transfer sent — I'll check it shortly", { exact: true })).toBeVisible()
  const bookings = await unwrap(fixture.admin.from('bookings').select('id,total_gbp,client_note').eq('client_id', fixture.profile.client_id))
  expect(bookings).toHaveLength(1); expect(bookings[0]).toMatchObject({ total_gbp: 200, client_note: 'Keep this note' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(errors).toEqual([])
})

test('cash is an explicit request awaiting approval', async ({ page }) => {
  await toPayment(page)
  await page.getByRole('button', { name: "I'd like to pay cash", exact: true }).click()
  await expect(page.getByText('Payment: Cash on arrival', { exact: true })).toBeVisible()
  await expect(page.getByText('Payment: Awaiting your bank transfer', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Confirm cash booking', exact: true }).click()
  await expect(page.getByText('Payment: Cash on arrival', { exact: true })).toBeVisible()
})

test('real expired-hold rejection never shows a successful confirmation', async ({ page }) => {
  await toDetails(page)
  const held = await page.evaluate(() => JSON.parse(sessionStorage.getItem('vad-v2-booking-draft-v1')).draft.hold)
  await unwrap(fixture.admin.from('booking_holds').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', held.hold_id))
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await expect(page.getByRole('alert')).toContainText('Time slot is no longer available')
  await expect(page.getByRole('heading', { name: 'Choose date and time' })).toBeVisible()
  await expect(page.getByRole('heading', { name: "I've received your booking" })).toHaveCount(0)
  expect(await unwrap(fixture.admin.from('bookings').select('id').eq('client_id', fixture.profile.client_id))).toHaveLength(0)
})

test('email registration activates the canonical client and preserves the draft', async ({ page }) => {
  await toReview(page)
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await page.getByRole('button', { name: 'Create an account', exact: true }).click()
  const email = `browser-signup-${crypto.randomUUID()}@example.test`
  await page.getByLabel('First name', { exact: true }).fill('Browser')
  await page.getByLabel('Last name', { exact: true }).fill('Registration')
  await page.getByLabel('Email address', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('button', { name: 'Register', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await expect(page.getByLabel('First name', { exact: true })).toHaveValue('Browser')
  const rows = await unwrap(fixture.admin.from('clients').select('auth_user_id').eq('email', email))
  expect(rows).toHaveLength(1)
  await fixture.trackUser(rows[0].auth_user_id)
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue(email)
  const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem('vad-v2-booking-draft-v1')).draft)
  expect(draft.sessions.map((session) => session.duration_minutes)).toEqual([60, 60])
  await fixture.publicApi.release(draft.hold, await page.evaluate(() => localStorage.getItem('vad-v2-hold-client-v1')))
})

test('changing duration releases the old hold and refreshes availability', async ({ page }) => {
  await toReview(page)
  const original = await page.evaluate(() => JSON.parse(sessionStorage.getItem('vad-v2-booking-draft-v1')).draft.hold)
  await page.getByRole('button', { name: /Sessions:.*Edit/ }).click()
  await page.getByRole('button', { name: 'Remove 60 minutes', exact: true }).click()
  await expect(page.getByRole('status', { name: '60 minute sessions' })).toHaveText('1')
  const rows = await unwrap(fixture.admin.from('booking_holds').select('status').eq('id', original.hold_id))
  expect(rows[0].status).toBe('released')
  await page.getByRole('button', { name: 'Choose date & time' }).click()
  await expect(page.getByRole('button', { name: 'Review booking', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '10:00', exact: true }).click()
  await page.getByRole('button', { name: 'Review booking', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Session 1 · 60 minutes' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Session 2 · 60 minutes' })).toHaveCount(0)
  const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem('vad-v2-booking-draft-v1')).draft)
  await fixture.publicApi.release(draft.hold, await page.evaluate(() => localStorage.getItem('vad-v2-hold-client-v1')))
})


for (const method of ['cash', 'bank_transfer']) test(`guest ${method} checkout completes without creating a password account`, async ({ page }) => {
  await toReview(page)
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await expect(page.getByRole('button', { name: 'Continue as guest' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Continue as guest' }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()

  const guestEmail = `guest-${crypto.randomUUID()}@example.test`
  await page.getByLabel('First name', { exact: true }).fill('Guest')
  await page.getByLabel('Last name', { exact: true }).fill('Client')
  await page.getByLabel('Email address', { exact: true }).fill(guestEmail)
  await page.getByLabel('Contact number', { exact: true }).fill('+44 7700 900321')
  await page.getByLabel('Street address', { exact: true }).fill('20 Guest Street')
  await page.getByLabel('Postcode', { exact: true }).fill('SW1A 2AA')
  await page.getByRole('button', { name: 'Continue to payment' }).click()

  await expect(page.getByRole('heading', { name: 'One last step' })).toBeVisible()
  const clients = await unwrap(fixture.admin.from('clients').select('auth_user_id').eq('normalized_email', guestEmail))
  expect(clients).toHaveLength(1)
  expect(clients[0].auth_user_id).toBeTruthy()
  await fixture.trackUser(clients[0].auth_user_id)

  if (method === 'cash') await page.getByRole('button', { name: "I'd like to pay cash", exact: true }).click()
  await page.getByLabel('I understand the payment and cancellation terms.').check()
  await page.getByRole('button', { name: method === 'cash' ? 'Confirm cash booking' : "I've made the bank transfer", exact: true }).click()
  await expect(page.getByRole('heading', { name: "I've received your booking" })).toBeVisible()
  await expect(page.getByText(guestEmail, { exact: true })).toBeVisible()
  await expect(page.getByText(method === 'cash' ? 'Payment: Cash on arrival' : "Payment: Transfer sent — I'll check it shortly", { exact: true })).toBeVisible()
  const bookings = await unwrap(fixture.admin.from('bookings').select('id').eq('client_id',
    (await unwrap(fixture.admin.from('clients').select('id').eq('auth_user_id', clients[0].auth_user_id)))[0].id))
  expect(bookings).toHaveLength(1)
})


async function readDraft(page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem('vad-v2-booking-draft-v1')).draft)
}

async function ageHold(page, minutesRemaining) {
  const held = await page.evaluate(() => JSON.parse(sessionStorage.getItem('vad-v2-booking-draft-v1')).draft.hold)
  const expires = new Date(Date.now() + minutesRemaining * 60000).toISOString()
  await unwrap(fixture.admin.from('booking_holds').update({ expires_at: expires,
    created_at: new Date(Date.parse(expires) - 20 * 60000).toISOString() }).eq('id', held.hold_id))
  await page.evaluate((expires_at) => {
    const saved = JSON.parse(sessionStorage.getItem('vad-v2-booking-draft-v1'))
    saved.draft.hold.expires_at = expires_at
    sessionStorage.setItem('vad-v2-booking-draft-v1', JSON.stringify(saved))
  }, expires)
  await page.reload()
  return { ...held, expires_at: expires }
}

test('normal twenty-minute hold stays invisible through typing, login and Back navigation', async ({ page }) => {
  const writes = []
  page.on('request', (request) => {
    if (/\/rpc\/(create_booking_hold|extend_booking_hold)$/.test(request.url())) writes.push(request.url())
  })
  await toDetails(page)
  const before = await readDraft(page)
  await expect(page.locator('.hold')).toHaveCount(0)
  await expect(page.getByText(/Your time is held for/)).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const row = (await unwrap(fixture.admin.from('booking_holds').select('created_at,expires_at,extended_at').eq('id', before.hold.hold_id)))[0]
  expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBe(20 * 60000)
  expect(row.extended_at).toBeNull()
  await page.getByLabel('Street address', { exact: true }).fill('11 Still typing Street')
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Review your booking' })).toBeVisible()
  await page.getByLabel('Session notes (optional)').fill('Still typing')
  await page.reload()
  expect((await readDraft(page)).hold).toEqual(before.hold)
  expect(writes).toHaveLength(1)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('warning begins only in the final minute, traps focus and has no ticking countdown', async ({ page }) => {
  await toDetails(page)
  const held = await ageHold(page, 2)
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // Move the browser clock without waiting two minutes; the deadline is fixed.
  await page.clock.setFixedTime(new Date(Date.parse(held.expires_at) - 61000))
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.clock.setFixedTime(new Date(Date.parse(held.expires_at) - 60000))
  const modal = page.getByRole('dialog', { name: 'Still booking?' })
  await expect(modal).toBeVisible()
  await expect(modal).toHaveAttribute('aria-modal', 'true')
  await expect(modal).toContainText('Your selected appointment time is about to be released. Would you like to keep it?')
  await expect(modal).not.toContainText(/\d+:\d+|seconds|minutes/)
  await expect(modal.getByRole('button', { name: 'Keep my time' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(modal.getByRole('button', { name: 'Release time' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(modal.getByRole('button', { name: 'Keep my time' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(modal.getByRole('button', { name: 'Release time' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(modal).toBeVisible()
  await page.screenshot({ path: 'test-results/hold-warning-mobile.png', fullPage: true })
})

test('reload after expiry immediately returns to time selection and preserves the draft', async ({ page }) => {
  await toDetails(page)
  const before = await readDraft(page)
  await ageHold(page, -1)
  await expect(page.getByRole('heading', { name: 'Choose date and time' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await readDraft(page)).toEqual({ ...before, hold: null, start: null })
  expect((await fixture.publicApi.availability(fixture.date, 120)).some((s) => s.start_minutes === 600)).toBe(true)
})

for (const event of ['focus', 'pageshow', 'visibilitychange']) test(`resume via ${event} reconciles expiry without a timer tick`, async ({ page }) => {
  await toDetails(page)
  const held = await ageHold(page, 2)
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  const before = await readDraft(page)
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  await unwrap(fixture.admin.from('booking_holds').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', held.hold_id))
  await page.clock.setSystemTime(new Date(Date.parse(held.expires_at) + 1000))
  await page.evaluate((name) => {
    const target = name === 'visibilitychange' ? document : window
    target.dispatchEvent(new Event(name))
  }, event)
  await expect(page.getByRole('heading', { name: 'Choose date and time' })).toBeVisible()
  expect(await readDraft(page)).toEqual({ ...before, hold: null, start: null })
  expect((await fixture.publicApi.availability(fixture.date, 120)).some((s) => s.start_minutes === 600)).toBe(true)
})

test('late extension rejected by the real server returns to time selection cleanly', async ({ page }) => {
  await toDetails(page)
  const before = await readDraft(page)
  const held = await ageHold(page, 0.9)
  await expect(page.getByRole('dialog')).toBeVisible()
  await unwrap(fixture.admin.from('booking_holds').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', held.hold_id))
  const response = page.waitForResponse('**/rpc/extend_booking_hold')
  await page.getByRole('button', { name: 'Keep my time' }).click()
  expect((await (await response).json()).code).toBe('23P01')
  await expect(page.getByRole('heading', { name: 'Choose date and time' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText('Your selected time was released. Please choose an available time to continue.')
  expect(await readDraft(page)).toEqual({ ...before, hold: null, start: null })
  expect((await unwrap(fixture.admin.from('booking_holds').select('extended_at').eq('id', held.hold_id)))[0].extended_at).toBeNull()
})

test('extension network failure is visible inside the modal and can be retried', async ({ page }) => {
  await toDetails(page)
  const held = await ageHold(page, 0.9)
  const modal = page.getByRole('dialog', { name: 'Still booking?' })
  await page.route('**/rpc/extend_booking_hold', (route) => route.abort(), { times: 1 })
  await modal.getByRole('button', { name: 'Keep my time' }).click()
  await expect(modal.getByRole('alert')).toBeVisible()
  expect((await readDraft(page)).hold.expires_at).toBe(held.expires_at)
  await modal.getByRole('button', { name: 'Keep my time' }).click()
  await expect(modal).toHaveCount(0)
  expect((await readDraft(page)).hold.extension_used).toBe(true)
})

test('one-minute modal extends the same real hold once and survives reload', async ({ page }) => {
  await toDetails(page)
  const held = await ageHold(page, 0.9)
  await expect(page.getByRole('dialog', { name: 'Still booking?' })).toBeVisible()
  await page.getByRole('button', { name: 'Keep my time', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.hold')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Keep my time', exact: true })).toHaveCount(0)
  const rows = await unwrap(fixture.admin.from('booking_holds').select('id,expires_at,extended_at').eq('id', held.hold_id))
  expect(Date.parse(rows[0].expires_at) - Date.parse(held.expires_at)).toBe(600000)
  expect(rows[0].extended_at).toBeTruthy()
  const current = await readDraft(page)
  expect(current.hold.hold_id).toBe(held.hold_id)
  expect(current.hold.hold_token).toBe(held.hold_token)
  const key = await page.evaluate(() => localStorage.getItem('vad-v2-hold-client-v1'))
  const retried = await fixture.publicApi.extend(held, key)
  expect(Date.parse(retried.expires_at)).toBe(Date.parse(rows[0].expires_at))
  expect(await unwrap(fixture.admin.from('booking_holds').select('id').eq('client_key', key))).toHaveLength(1)
  expect((await fixture.publicApi.availability(fixture.date, 120)).some((slot) => slot.start_minutes === 600)).toBe(false)
  await page.reload()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.hold')).toHaveCount(0)
  await ageHold(page, 0.9)
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('release at the prompt frees the slot and preserves address and sessions', async ({ page }) => {
  await toDetails(page)
  const before = await readDraft(page)
  const held = await ageHold(page, 0.9)
  await page.getByRole('button', { name: 'Release time', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Choose date and time' })).toBeVisible()
  await expect(page.getByRole('button', { name: '10:00', exact: true })).toBeVisible()
  expect((await unwrap(fixture.admin.from('booking_holds').select('status').eq('id', held.hold_id)))[0].status).toBe('released')
  const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem('vad-v2-booking-draft-v1')).draft)
  expect(draft).toEqual({ ...before, hold: null, start: null })
  expect((await fixture.publicApi.availability(fixture.date, 120)).some((s) => s.start_minutes === 600)).toBe(true)
  expect(draft.details.address_line_1).toBe('10 Browser Street')
  expect(draft.sessions.map((s) => s.duration_minutes)).toEqual([60, 60])
  await page.getByRole('button', { name: '10:00', exact: true }).click()
  await page.getByRole('button', { name: 'Review booking', exact: true }).click()
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await expect(page.getByLabel('Street address', { exact: true })).toHaveValue('10 Browser Street')
})

test('ignoring the modal releases availability at real expiry and preserves details', async ({ page }) => {
  await toDetails(page)
  const before = await readDraft(page)
  const held = await ageHold(page, 0.05)
  await expect(page.getByRole('dialog', { name: 'Still booking?' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Choose date and time' })).toBeVisible({ timeout: 10000 })
  await expect(page.getByRole('alert')).toContainText('Your selected time was released')
  const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem('vad-v2-booking-draft-v1')).draft)
  expect(draft).toEqual({ ...before, hold: null, start: null })
  expect((await fixture.publicApi.availability(fixture.date, 120)).some((s) => s.start_minutes === 600)).toBe(true)
  expect((await unwrap(fixture.admin.from('booking_holds').select('extended_at').eq('id', held.hold_id)))[0].extended_at).toBeNull()
  expect(draft.hold).toBeNull()
  expect(draft.details.address_line_1).toBe('10 Browser Street')
  expect(draft.enhancementIds).toEqual([fixture.ids.enhancement])
  expect(draft.sessions.map((s) => s.duration_minutes)).toEqual([60, 60])
})


test('owner alternatives remain complete after Back and reload and switching releases the old hold', async ({ page }) => {
  await toReview(page)
  const original = await page.evaluate(() => JSON.parse(sessionStorage.getItem('vad-v2-booking-draft-v1')).draft.hold)
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Choose date and time' })).toBeVisible()
  const slots = page.locator('.slots button')
  const expected = Array.from({ length: 21 }, (_, i) => {
    const minutes = 600 + i * 30
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  })
  await expect(slots).toHaveText(expected)
  expect(await fixture.publicApi.availability(fixture.date, 120)).toEqual([{ start_minutes: 780 }])
  await page.reload()
  await expect(slots).toHaveText(expected)
  await page.getByRole('button', { name: '10:30', exact: true }).click()
  await expect(page.getByRole('button', { name: '10:30', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(slots).toHaveText(expected)
  expect((await unwrap(fixture.admin.from('booking_holds').select('status').eq('id', original.hold_id)))[0].status).toBe('released')
  expect(await fixture.publicApi.availability(fixture.date, 120)).toEqual([{ start_minutes: 810 }])
  await page.getByRole('button', { name: 'Review booking', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review your booking' })).toBeVisible()
  await page.goBack()
  await expect(slots).toHaveText(expected)
  await page.reload()
  await expect(slots).toHaveText(expected)
  await expect(page.getByRole('button', { name: '10:30', exact: true })).toHaveAttribute('aria-pressed', 'true')
})


test('provisional payment shows canonical email/postcode and survives reload before transfer', async ({ page }) => {
  await toPayment(page)
  await expect(page.getByRole('dialog', { name: 'Still booking?' })).toHaveCount(0)
  await expect(page.locator('.hold')).toHaveCount(0)
  await expect(page.getByText(fixture.email, { exact: true })).toBeVisible()
  await expect(page.getByText('Payment: Awaiting your bank transfer', { exact: true })).toBeVisible()
  await expect(page.locator('[aria-current=step]')).toHaveText('Payment')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/mobile-payment.png', fullPage: true })
  const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem('vad-v2-booking-draft-v1')).draft)
  const row = await fixture.api.booking(draft.bookingId)
  expect(row.booking_payments.payment_reference).toBe(row.booking_reference)
  expect(row.booking_status).toBe('awaiting_transfer')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Copy payment reference' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Still booking?' })).toHaveCount(0)
  await expect(page.getByText(row.booking_reference, { exact: true })).toHaveCount(2)
  await page.getByLabel('I understand the payment and cancellation terms.').check()
  await page.getByRole('button', { name: "I've made the bank transfer", exact: true }).click()
  await expect(page.getByRole('heading', { name: "I've received your booking" })).toBeVisible()
  await expect(page.getByText(fixture.email, { exact: true })).toBeVisible()
  await expect(page.getByText('10 Browser Street, London, SW1A 1AA', { exact: true })).toBeVisible()
})

test('a pending reservation has no deadline: it survives a reload and keeps its time', async ({ page }) => {
  await toPayment(page)
  const id = await page.evaluate(() => JSON.parse(sessionStorage.getItem('vad-v2-booking-draft-v1')).draft.bookingId)
  await page.reload()
  await expect(page.getByText('Your appointment time is reserved for you.')).toBeVisible()
  await expect(page.getByRole('button', { name: "I've made the bank transfer", exact: true })).toBeVisible()
  expect((await fixture.publicApi.availability(fixture.date,120)).some((s) => s.start_minutes===600)).toBe(false)
  const row = await unwrap(fixture.admin.from('bookings').select('payment_reservation_expires_at').eq('id',id).single())
  expect(row.payment_reservation_expires_at).toBeNull()
})

test('lost transfer response recovers the canonical result on reload without double writes', async ({ page }) => {
  await toPayment(page)
  await page.route('**/rpc/declare_my_bank_transfer', async (route) => { await route.fetch(); await route.abort() }, { times: 1 })
  await page.getByRole('button', { name: "I've made the bank transfer", exact: true }).click()
  await expect(page.getByRole('button', { name: 'Retry payment request' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: "I've received your booking" })).toBeVisible()
  await expect(page.getByText("Payment: Transfer sent — I'll check it shortly", { exact: true })).toBeVisible()
  const rows = await unwrap(fixture.admin.from('bookings').select('id').eq('client_id',fixture.profile.client_id))
  expect(rows).toHaveLength(1)
  expect(await unwrap(fixture.admin.from('event_outbox').select('id').eq('aggregate_id',rows[0].id).eq('event_type','booking.transfer_declared'))).toHaveLength(1)
})


test('lost reservation response retries the same booking before any transfer', async ({ page }) => {
  await toDetails(page)
  await page.route('**/rpc/finalize_client_booking', async (route) => { await route.fetch(); await route.abort() }, { times: 1 })
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await expect(page.getByRole('button', { name: 'Retry booking request' })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Retry booking request' }).click()
  await expect(page.getByRole('button', { name: 'Copy payment reference' })).toBeVisible()
  await expect(page.getByText('Payment: Awaiting your bank transfer', { exact: true })).toBeVisible()
  expect(await unwrap(fixture.admin.from('bookings').select('id').eq('client_id',fixture.profile.client_id))).toHaveLength(1)
})


for (const decision of ['approve', 'reject', 'receive']) test(`saved client confirmation reflects Admin cash ${decision}`, async ({ page }) => {
  await toPayment(page)
  await page.getByRole('button', { name: "I'd like to pay cash" }).click()
  await page.getByRole('button', { name: 'Confirm cash booking', exact: true }).click()
  await expect(page.getByRole('heading', { name: "I've received your booking" })).toBeVisible()
  const user = (await fixture.client.auth.getUser()).data.user
  await unwrap(fixture.admin.from('admin_users').insert({ user_id: user.id }))
  const booking = await unwrap(fixture.admin.from('bookings').select('id').eq('client_id', fixture.profile.client_id).single())
  async function act(name) {
    const row = await unwrap(fixture.admin.from('bookings').select('updated_at,booking_payments(updated_at)').eq('id', booking.id).single())
    await unwrap(fixture.client.rpc(name, { p_booking_id: booking.id, p_request_id: crypto.randomUUID(), p_booking_updated_at: row.updated_at, p_payment_updated_at: row.booking_payments.updated_at }))
  }
  try {
    await act(decision === 'reject' ? 'admin_reject_cash_request' : 'admin_approve_cash_request')
    if (decision === 'receive') await act('admin_record_payment_received')
    await page.reload()
    await expect(page.getByRole('heading', { name: decision === 'reject' ? 'Your appointment is cancelled' : 'Your appointment is confirmed' })).toBeVisible()
    await expect(page.getByText("I'll confirm your appointment as soon as possible.", { exact: true })).toHaveCount(0)
    if (decision === 'receive') await expect(page.getByText('Payment: Payment received', { exact: true })).toBeVisible()
    if (decision === 'reject') await expect(page.getByText('This appointment will not go ahead.', { exact: false })).toBeVisible()
    if (decision === 'approve') await expect(page.getByText('Please pay the full amount in cash at your appointment.')).toBeVisible()
  } finally {
    await unwrap(fixture.admin.from('event_outbox').delete().eq('aggregate_id', booking.id))
    await unwrap(fixture.admin.from('command_requests').delete().eq('scope', `admin-payment:${user.id}`))
  }
})

test('bank details saved by the Admin appear at payment, in place of the build-time fallback', async ({ page }) => {
  const original = (await fixture.admin.from('business_settings').select('*').eq('key', 'bank_details')).data
  await unwrap(fixture.admin.from('business_settings').upsert({ key: 'bank_details', value: { account_name: 'Saved In App', sort_code: '11-22-33', account_number: '44556677', note: 'Please use the reference exactly' } }))
  try {
    await toPayment(page)
    await expect(page.getByText('Saved In App', { exact: true })).toBeVisible()
    await expect(page.getByText('11-22-33', { exact: true })).toBeVisible()
    await expect(page.getByText('Please use the reference exactly')).toBeVisible()
    await expect(page.getByText('LOCAL TEST ONLY')).toHaveCount(0)
  } finally {
    if (original.length) await fixture.admin.from('business_settings').upsert(original)
    else await fixture.admin.from('business_settings').delete().eq('key', 'bank_details')
  }
})
