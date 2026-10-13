import { test, expect } from '@playwright/test'
import { localFixture } from '../localSupabase.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'

// The box on a client's confirmation page that offers Telegram updates. The test site is given a made-up bot name (tests/start-local-ui.js),
// so the box shows; Telegram itself is never called: the chat is linked the way the webhook does it, with the service key.
let fixture
test.beforeEach(async () => { fixture = await localFixture(27) })
test.afterEach(async ({ page }) => {
  if (fixture && page.url().startsWith('http://127.0.0.1:5174')) fixture.trackKey(await page.evaluate(() => localStorage.getItem('vad-v2-hold-client-v1')))
  await fixture?.cleanup()
})

const BOT = 'vad_test_clients_bot'
const chat = () => 700000000 + Math.floor(Math.random() * 90000000)

// The first part of every journey: the treatment and the time, up to the page that asks who is booking.
async function toDetails(page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Integration area/ }).click()
  await page.getByRole('button', { name: /Integration massage/ }).click()
  await page.getByRole('button', { name: /more than one person/ }).click()
  await page.getByRole('button', { name: 'Add 60 minutes', exact: true }).click()
  await page.getByRole('button', { name: 'Add 60 minutes', exact: true }).click()
  await page.getByRole('button', { name: 'Choose date & time' }).click()
  await page.getByLabel('Appointment date').fill(fixture.date)
  await page.getByRole('button', { name: '10:00', exact: true }).click()
  await page.getByRole('button', { name: 'Review booking', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review your booking' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue to your details' }).click()
}

// A guest: no account and no password, a booking made on a session of their own.
async function bookAsGuest(page) {
  await toDetails(page)
  await page.getByRole('button', { name: 'Continue as guest' }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  const email = `guest-${crypto.randomUUID()}@example.test`
  await page.getByLabel('First name', { exact: true }).fill('Gwen')
  await page.getByLabel('Last name', { exact: true }).fill('Guest')
  await page.getByLabel('Email address', { exact: true }).fill(email)
  await page.getByLabel('Contact number', { exact: true }).fill('+44 7700 900322')
  await page.getByLabel('Street address', { exact: true }).fill('20 Guest Street')
  await page.getByLabel('Postcode', { exact: true }).fill('SW1A 2AA')
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await expect(page.getByRole('heading', { name: 'One last step' })).toBeVisible()
  const client = (await unwrap(fixture.admin.from('clients').select('id, auth_user_id').eq('normalized_email', email)))[0]
  await fixture.trackUser(client.auth_user_id)
  await page.getByLabel('I understand the payment and cancellation terms.').check()
  await page.getByRole('button', { name: "I've made the bank transfer" }).click()
  await expect(page.getByRole('heading', { name: "I've received your booking" })).toBeVisible()
  return client
}

// The usual journey for a returning client, ending on the confirmation page ("I've received your booking").
async function book(page) {
  await toDetails(page)
  await page.getByText('Returning client? Sign in').click()
  await page.getByLabel('Email address', { exact: true }).fill(fixture.email)
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await page.getByLabel('Street address', { exact: true }).fill('10 Browser Street')
  await page.getByLabel('Postcode', { exact: true }).fill('sw1a1aa')
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await page.getByLabel('I understand the payment and cancellation terms.').check()
  await page.getByRole('button', { name: "I've made the bank transfer" }).click()
  await expect(page.getByRole('heading', { name: "I've received your booking" })).toBeVisible()
}
const box = page => page.getByRole('region', { name: /Telegram/ })
const tokens = async () => (await unwrap(fixture.admin.from('client_telegram_tokens').select('id').eq('client_id', fixture.profile.client_id))).length
const codeOf = async page => new URL(await box(page).getByRole('link', { name: 'Open Telegram' }).getAttribute('href')).searchParams.get('start')

test('the box offers one tap to the clients-only bot with a one-time code, and the page notices when the chat is linked', async ({ page }) => {
  await book(page)
  await expect(box(page).getByRole('heading', { name: 'Get updates on Telegram' })).toBeVisible()
  await expect(box(page)).toContainText("I'll message you when your appointment is confirmed, moved or cancelled.")
  const link = box(page).getByRole('link', { name: 'Open Telegram' })
  await expect(link).toHaveAttribute('href', new RegExp(`^https://t\\.me/${BOT}\\?start=[0-9a-f]{32}$`))
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', /noopener/)
  // It sits above the booking itself, near the top of the page.
  const boxTop = (await box(page).boundingBox()).y
  expect(boxTop).toBeLessThan((await page.getByRole('region', { name: 'Appointment summary' }).boundingBox()).y)
  expect(await tokens()).toBe(1)
  // Pressing Start in Telegram makes the webhook link the chat; the page sees it without being reloaded.
  const code = await codeOf(page)
  expect((await fixture.admin.rpc('link_client_telegram', { p_token: code, p_chat_id: chat() })).data).toEqual({ status: 'linked', first_name: 'Test' })
  await expect(box(page).getByRole('heading', { name: "You're connected on Telegram" })).toBeVisible({ timeout: 15000 })
  await expect(box(page).getByRole('link', { name: 'Open Telegram' })).toHaveCount(0)
  await expect(box(page)).toContainText('Send /stop in the chat to turn it off.')
  await expect(page.getByRole('status').filter({ hasText: "You're connected on Telegram." })).toHaveCount(1)
  // A reload says so at once, and does not make another code.
  await page.reload()
  await expect(box(page).getByRole('heading', { name: "You're connected on Telegram" })).toBeVisible()
  expect(await tokens()).toBe(1)
})

test('a code left showing for over an hour is replaced when the page is looked at again', async ({ page }) => {
  await book(page)
  const first = await codeOf(page)
  expect(await tokens()).toBe(1)
  await page.clock.install({ time: new Date() })
  // Nothing is replaced early: coming back after half an hour changes nothing.
  await page.clock.fastForward('30:00')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(async () => expect(await tokens()).toBe(1)).toPass({ timeout: 4000 })
  expect(await codeOf(page)).toBe(first)
  await page.clock.fastForward('40:00')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(async () => expect(await tokens()).toBe(2)).toPass({ timeout: 8000 })
  await expect(async () => expect(await codeOf(page)).not.toBe(first)).toPass({ timeout: 8000 })
  expect(await codeOf(page)).toMatch(/^[0-9a-f]{32}$/)
})

test('it is on the confirmed page as well, and not on a cancelled one', async ({ page }) => {
  await book(page)
  const booking = (await unwrap(fixture.admin.from('bookings').select('id').eq('client_id', fixture.profile.client_id)))[0]
  await unwrap(fixture.admin.from('bookings').update({ booking_status: 'confirmed' }).eq('id', booking.id))
  await unwrap(fixture.admin.from('booking_payments').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('booking_id', booking.id))
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Your appointment is confirmed' })).toBeVisible()
  await expect(box(page).getByRole('heading', { name: 'Get updates on Telegram' })).toBeVisible()
  await unwrap(fixture.admin.from('bookings').update({ booking_status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', booking.id))
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Your appointment is cancelled' })).toBeVisible()
  // The box takes a moment to appear when it is going to (it asks the database first), so "not there" is only believed once the page has gone quiet.
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(700)
  await expect(box(page)).toHaveCount(0)
})

const bookingId = async () => (await unwrap(fixture.admin.from('bookings').select('id').eq('client_id', fixture.profile.client_id)))[0].id

test('a guest, who made no account, gets the box too, and it links their chat', async ({ page }) => {
  const guest = await bookAsGuest(page)
  await expect(box(page).getByRole('heading', { name: 'Get updates on Telegram' })).toBeVisible()
  const code = await codeOf(page)
  expect((await unwrap(fixture.admin.from('client_telegram_tokens').select('id').eq('client_id', guest.id)))).toHaveLength(1)
  expect((await fixture.admin.rpc('link_client_telegram', { p_token: code, p_chat_id: chat() })).data).toEqual({ status: 'linked', first_name: 'Gwen' })
  await expect(box(page).getByRole('heading', { name: "You're connected on Telegram" })).toBeVisible({ timeout: 15000 })
  expect((await unwrap(fixture.admin.from('client_telegram_links').select('client_id').eq('client_id', guest.id)))).toHaveLength(1)
})

test('it is on the "Your appointment" page too, so it can still be found after the confirmation is closed, and not for a cancelled booking', async ({ page }) => {
  await book(page)
  const id = await bookingId()
  await page.goto(`/account?booking=${id}`)
  await expect(box(page).getByRole('heading', { name: 'Get updates on Telegram' })).toBeVisible()
  await expect(box(page).getByRole('link', { name: 'Open Telegram' })).toHaveAttribute('href', new RegExp(`^https://t\\.me/${BOT}\\?start=[0-9a-f]{32}$`))
  // It sits above the booking itself there too, and links like the one on the confirmation page.
  expect((await box(page).boundingBox()).y).toBeLessThan((await page.getByRole('region', { name: 'Appointment summary' }).boundingBox()).y)
  const code = await codeOf(page)
  expect((await fixture.admin.rpc('link_client_telegram', { p_token: code, p_chat_id: chat() })).data.status).toBe('linked')
  await expect(box(page).getByRole('heading', { name: "You're connected on Telegram" })).toBeVisible({ timeout: 15000 })
  await unwrap(fixture.admin.from('bookings').update({ booking_status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', id))
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Your appointment is cancelled' })).toBeVisible()
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(700)
  await expect(box(page)).toHaveCount(0)
})

test('after /stop the box offers to switch the updates back on, with a new code', async ({ page }) => {
  await book(page)
  const first = await codeOf(page)
  const theChat = chat()
  expect((await fixture.admin.rpc('link_client_telegram', { p_token: first, p_chat_id: theChat })).data.status).toBe('linked')
  await expect(box(page).getByRole('heading', { name: "You're connected on Telegram" })).toBeVisible({ timeout: 15000 })
  // Sending /stop in the chat: the webhook ends the link.
  expect((await fixture.admin.rpc('stop_client_telegram', { p_chat_id: theChat })).data).toBe(1)
  await page.goto(`/account?booking=${await bookingId()}`)
  await expect(box(page).getByRole('heading', { name: 'Get updates on Telegram' })).toBeVisible()
  const second = await codeOf(page)
  expect(second).toMatch(/^[0-9a-f]{32}$/)
  expect(second).not.toBe(first)
  // The old code was spent when the chat linked, and the new one links the same chat again.
  expect((await fixture.admin.rpc('link_client_telegram', { p_token: first, p_chat_id: chat() })).data.status).toBe('used')
  expect((await fixture.admin.rpc('link_client_telegram', { p_token: second, p_chat_id: theChat })).data.status).toBe('linked')
  await expect(box(page).getByRole('heading', { name: "You're connected on Telegram" })).toBeVisible({ timeout: 15000 })
})

test('pressing the button makes the page look again for a few minutes, even when it had been open for a long time', async ({ page }) => {
  await book(page)
  const code = await codeOf(page)
  await page.clock.install({ time: new Date() })
  // After its first few minutes the page stops looking by itself: a chat linked now is not noticed until the client comes back to the page.
  await page.clock.fastForward('06:00')
  expect((await fixture.admin.rpc('link_client_telegram', { p_token: code, p_chat_id: chat() })).data.status).toBe('linked')
  await page.clock.fastForward('00:15')
  // (The page's own timer ticks every three real seconds, so wait for a few ticks: none of them may look.)
  await page.waitForTimeout(7000)
  await expect(box(page).getByRole('heading', { name: 'Get updates on Telegram' })).toBeVisible()
  // Pressing the button (the page itself stays where it is) starts the looking again, and the page then notices without being touched.
  const link = box(page).getByRole('link', { name: 'Open Telegram' })
  await link.evaluate(element => element.addEventListener('click', event => event.preventDefault()))
  await link.click()
  await page.clock.fastForward('00:09')
  await expect(box(page).getByRole('heading', { name: "You're connected on Telegram" })).toBeVisible({ timeout: 15000 })
})

test('when anything goes wrong the client sees nothing of it: the box is just not there', async ({ page }) => {
  await page.route('**/rpc/create_my_telegram_link', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'boom: a technical detail', code: 'XX000' }) }))
  await book(page)
  await expect(page.getByRole('heading', { name: "I've received your booking" })).toBeVisible()
  await page.waitForTimeout(800)
  await expect(box(page)).toHaveCount(0)
  await expect(page.getByText('boom')).toHaveCount(0)
  await expect(page.getByText('technical detail')).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(await tokens()).toBe(0)
})

test('the box fits a phone and a very small phone', async ({ page }) => {
  await book(page)
  await expect(box(page)).toBeVisible()
  for (const [width, height] of [[390, 844], [320, 700]]) {
    await page.setViewportSize({ width, height })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    const area = await box(page).boundingBox()
    expect(area.x).toBeGreaterThanOrEqual(0)
    expect(area.x + area.width).toBeLessThanOrEqual(width)
  }
})
