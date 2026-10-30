import { test, expect } from '@playwright/test'
import { chooseLength } from '../bookingSteps.js'
import { localFixture } from '../localSupabase.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'
import { addDays } from '../../src/client/booking/dateStrip.js'

let fixture
const extraDays = []
test.beforeEach(async () => { fixture = await localFixture(25) })
test.afterEach(async ({ page }) => {
  if (fixture && page.url().startsWith('http://127.0.0.1:5174')) fixture.trackKey(await page.evaluate(() => localStorage.getItem('vad-v2-hold-client-v1')))
  if (extraDays.length) await fixture?.admin.from('working_hours_overrides').delete().in('date', extraDays.splice(0))
  await fixture?.cleanup()
})

async function toDuration(page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Integration area/ }).click()
  await page.getByRole('button', { name: /Integration massage/ }).click()
}
async function readDraft(page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem('vad-v2-booking-draft-v1')).draft)
}
// Names what is too wide, so a failure says where to look.
const noSideways = page => page.evaluate(() => {
  if (document.documentElement.scrollWidth <= window.innerWidth) return true
  const wide = [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5).slice(0, 6).map((el) => `${el.tagName.toLowerCase()}.${el.className} (${(el.textContent || '').trim().slice(0, 30)})`)
  throw new Error(`Wider than the screen: ${wide.join('; ')}`)
})

test('each screen has its question as the heading, named in the tab and read out first', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle('Area · Book a massage · VadMassage')
  await page.getByRole('button', { name: /Integration area/ }).click()
  await expect(page).toHaveTitle('Treatment · Book a massage · VadMassage')
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
  await page.getByRole('button', { name: /Integration massage/ }).click()
  await expect(page).toHaveTitle('People & length · Book a massage · VadMassage')
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
})

test('tapping a length goes straight on to the time, and the first free day is already open', async ({ page }) => {
  await toDuration(page)
  // How many people comes first, and nothing is chosen for the client.
  await expect(page.getByRole('heading', { name: 'How many people?' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Just me/ })).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: /^Just me/ }).click()
  // Every length says how many people and the price, not "per person".
  await expect(page.getByRole('button', { name: /^60 minutes · 1 person · £\d+\.\d\d$/ })).toBeVisible()
  await page.getByRole('button', { name: /^90 minutes/ }).click()
  await expect(page.getByRole('heading', { name: 'Choose date and time' })).toBeVisible()
  const draft = await readDraft(page)
  expect(draft.sessions.map((session) => session.duration_minutes)).toEqual([90])
  const chosen = page.locator('.daychip[aria-pressed=true]')
  await expect(chosen).toHaveAttribute('data-free', 'yes')
  await expect(page.locator('.slots button').first()).toBeVisible()
  // Days before the first free one are shown as full, so it is clear nothing nearer was missed.
  const before = await page.locator('.daychip').evaluateAll((chips) => chips.slice(0, chips.findIndex((chip) => chip.getAttribute('aria-pressed') === 'true')).map((chip) => chip.getAttribute('data-free')))
  expect(before.every((state) => state === 'no')).toBe(true)
  expect(await noSideways(page)).toBe(true)
})

test('looking at another day does not let go of the time already held', async ({ page }) => {
  const second = addDays(fixture.date, 1)
  extraDays.push(second)
  await fixture.admin.from('working_hours_overrides').upsert({ date: second, available: true, start_minutes: 600, end_minutes: 1320, start_mode: 'flexible', fixed_start_minutes: null })
  await toDuration(page)
  await chooseLength(page, 60)
  await page.getByLabel('Appointment date').fill(fixture.date)
  await page.getByRole('button', { name: '11:00', exact: true }).click()
  await expect(page.getByRole('button', { name: '11:00', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const held = (await readDraft(page)).hold
  // Another day, only looked at: the summary and the held time stay as they were.
  await page.getByRole('button', { name: new RegExp(`^${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${second}T12:00:00Z`)).replace(',', '')}`) }).click()
  await expect(page.getByLabel('Appointment date')).toHaveValue(second)
  await expect(page.getByRole('button', { name: 'Review booking', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '11:00', exact: true })).toHaveAttribute('aria-pressed', 'false')
  expect((await unwrap(fixture.admin.from('booking_holds').select('status').eq('id', held.hold_id)))[0].status).not.toBe('released')
  expect((await readDraft(page)).date).toBe(fixture.date)
  // Choosing a time on the new day moves the hold there, and the old one is let go.
  await page.getByRole('button', { name: '12:00', exact: true }).click()
  await expect(page.getByRole('button', { name: '12:00', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const moved = await readDraft(page)
  expect(moved).toMatchObject({ date: second, start: 720 })
  expect(moved.hold.hold_id).not.toBe(held.hold_id)
  expect((await unwrap(fixture.admin.from('booking_holds').select('status').eq('id', held.hold_id)))[0].status).toBe('released')
})

test('the price follows the choices by itself, with no button to press', async ({ page }) => {
  await toDuration(page)
  await chooseLength(page, 60)
  await page.getByLabel('Appointment date').fill(fixture.date)
  await page.getByRole('button', { name: '10:00', exact: true }).click()
  await page.getByRole('button', { name: 'Review booking', exact: true }).click()
  await expect(page.locator('.prices-total dd')).toHaveText('£105.00')
  await expect(page.getByRole('button', { name: 'Refresh price' })).toHaveCount(0)
  await page.getByLabel(/Integration enhancement/).check()
  await expect(page.locator('.prices-total dd')).toHaveText('£115.00')
  await expect(page.getByText('Extras', { exact: true })).toBeVisible()
  await page.getByLabel(/Integration enhancement/).uncheck()
  await expect(page.locator('.prices-total dd')).toHaveText('£105.00')
  await expect(page.getByText('Extras', { exact: true })).toHaveCount(0)
  expect(await noSideways(page)).toBe(true)
})

test('the guest way on is the big button, with signing in and creating an account plainly beside it', async ({ page }) => {
  await toDuration(page)
  await chooseLength(page, 60)
  await page.getByLabel('Appointment date').fill(fixture.date)
  await page.getByRole('button', { name: '10:00', exact: true }).click()
  await page.getByRole('button', { name: 'Review booking', exact: true }).click()
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await expect(page.getByRole('button', { name: 'Continue as guest' })).toBeVisible()
  // Both ways of having an account are in plain sight, but the forms stay closed until one is asked for.
  await expect(page.getByRole('button', { name: 'Sign in with email' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create an account', exact: true })).toBeVisible()
  await expect(page.getByLabel('Email address', { exact: true })).toBeHidden()
  await page.getByRole('button', { name: 'Sign in with email' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  await expect(page.getByLabel('Email address', { exact: true })).toBeVisible()
  await expect(page.getByLabel('First name', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Create an account', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
  await expect(page.getByLabel('First name', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue as guest' })).toBeVisible()
  await page.getByRole('button', { name: 'Already registered? Sign in' }).click()
  await page.getByRole('button', { name: 'Forgot password?' }).click()
  await expect(page.getByRole('button', { name: 'Send reset link' })).toBeVisible()
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Back to sign in' }).click()
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
})

test('every booking screen fits a 320px phone, and the usual booking is offered next time', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  const errors = []; page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  expect(await noSideways(page)).toBe(true)
  await page.getByRole('button', { name: /Integration area/ }).click()
  expect(await noSideways(page)).toBe(true)
  await page.getByRole('button', { name: /Integration massage/ }).click()
  expect(await noSideways(page)).toBe(true)
  await page.getByRole('button', { name: /^2 people/ }).click()
  expect(await noSideways(page)).toBe(true)
  await page.getByRole('button', { name: 'Different length for each person' }).click()
  expect(await noSideways(page)).toBe(true)
  await page.getByRole('button', { name: 'Change number of people' }).click()
  await chooseLength(page, 60)
  await page.getByLabel('Appointment date').fill(fixture.date)
  await page.getByRole('button', { name: '10:00', exact: true }).click()
  expect(await noSideways(page)).toBe(true)
  await page.getByRole('button', { name: 'Review booking', exact: true }).click()
  await page.getByText('Your preferences').click()
  expect(await noSideways(page)).toBe(true)
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await page.getByRole('button', { name: 'Continue as guest' }).click()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  await page.getByLabel('First name', { exact: true }).fill('Usual')
  await page.getByLabel('Last name', { exact: true }).fill('Client')
  const email = `usual-${crypto.randomUUID()}@example.test`
  await page.getByLabel('Email address', { exact: true }).fill(email)
  await page.getByLabel('Contact number', { exact: true }).fill('+44 7700 900654')
  await page.getByRole('textbox', { name: 'Address', exact: true }).fill('3 Usual Road, London, SW1A 2AA')
  expect(await noSideways(page)).toBe(true)
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await expect(page.getByRole('heading', { name: 'One last step' })).toBeVisible()
  const user = (await unwrap(fixture.admin.from('clients').select('auth_user_id').eq('normalized_email', email)))[0].auth_user_id
  await fixture.trackUser(user)
  expect(await noSideways(page)).toBe(true)
  // The bank details come first, then the terms, then what happens next, and the booking itself last.
  const top = async (locator) => (await locator.boundingBox()).y
  const order = [await top(page.locator('.bank-card')), await top(page.locator('label.terms')), await top(page.getByRole('heading', { name: 'What happens next' })), await top(page.getByRole('region', { name: 'Appointment summary' }))]
  expect(order).toEqual([...order].sort((first, second) => first - second))
  // A client who changes their mind has a way to change the time or cancel, right on the payment screen.
  await expect(page.getByRole('link', { name: 'Change the time or cancel this booking' })).toHaveAttribute('href', /\/account\?booking=/)
  // Pressing the button before the box is ticked asks for the tick, and takes her to it, instead of doing nothing.
  await page.getByRole('button', { name: "I've made the bank transfer" }).click()
  await expect(page.getByRole('alert')).toContainText('Please tick the box')
  await expect(page.getByLabel('I understand the payment and cancellation terms.')).toBeFocused()
  await page.getByLabel('I understand the payment and cancellation terms.').check()
  await page.getByRole('button', { name: "I've made the bank transfer" }).click()
  await expect(page.getByRole('heading', { name: "I've received your booking" })).toBeVisible()
  expect(await noSideways(page)).toBe(true)
  // The next visit starts from the last booking: tap it and the time is the only choice left.
  await page.getByRole('button', { name: 'Book another appointment' }).click()
  await expect(page.getByRole('heading', { name: 'Choose your area', level: 2 })).toBeVisible()
  const usual = page.getByRole('button', { name: /Book your usual/ })
  await expect(usual).toContainText('Integration massage · 60 min · Integration area')
  await usual.click()
  await expect(page.getByRole('heading', { name: 'Choose date and time' })).toBeVisible()
  expect((await readDraft(page)).sessions.map((session) => session.duration_minutes)).toEqual([60])
  expect(errors).toEqual([])
})

test('the first area is on screen without scrolling, and how booking works comes after the areas', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const first = page.locator('.tiles--areas .tile').first()
  await expect(first).toBeVisible()
  const box = await first.boundingBox()
  expect(box.y + box.height).toBeLessThan(844)
  const steps = await page.getByRole('list', { name: 'How booking works' }).boundingBox()
  expect(steps.y).toBeGreaterThan(box.y)
})

test('a link with the area, treatment and length in it opens the booking part-way through', async ({ page }) => {
  await page.goto('/?area=integration-area&treatment=integration-massage&minutes=90')
  await expect(page.getByRole('heading', { name: 'Choose date and time' })).toBeVisible()
  const draft = await readDraft(page)
  expect(draft).toMatchObject({ areaId: fixture.ids.area, serviceId: fixture.ids.service })
  expect(draft.sessions.map((session) => session.duration_minutes)).toEqual([90])
  // An area alone carries on to the treatment, and an unknown name is simply ignored.
  const second = await page.context().newPage()
  await second.goto('/?area=integration-area')
  await expect(second.getByRole('heading', { name: 'What would help you most today?' })).toBeVisible()
  const third = await page.context().newPage()
  await third.goto('/?area=nowhere')
  await expect(third.getByRole('heading', { name: 'Choose your area', level: 2 })).toBeVisible()
  await second.close(); await third.close()
})

test('a time someone else has just taken says so kindly and leaves the list', async ({ page }) => {
  await toDuration(page)
  await chooseLength(page, 60)
  await page.getByLabel('Appointment date').fill(fixture.date)
  await expect(page.getByRole('button', { name: '10:00', exact: true })).toBeVisible()
  // Another visitor takes 10:00 while this one is looking at the list.
  await fixture.publicApi.hold(fixture.date, 600, 60, fixture.key())
  await page.getByRole('button', { name: '10:00', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'that time has just been taken' })).toBeVisible()
  await expect(page.getByRole('button', { name: '10:00', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Review booking', exact: true })).toBeDisabled()
})

test('the details button is never greyed out: what is missing is said in words', async ({ page }) => {
  await toDuration(page)
  await chooseLength(page, 60)
  await page.getByLabel('Appointment date').fill(fixture.date)
  await page.getByRole('button', { name: '10:00', exact: true }).click()
  await page.getByRole('button', { name: 'Review booking', exact: true }).click()
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await page.getByRole('button', { name: 'Continue as guest' }).click()
  const next = page.getByRole('button', { name: 'Continue to payment' })
  await expect(next).toBeEnabled()
  // Empty: the phone's own prompt points at the first thing missing, and nothing moves on.
  await next.click()
  await expect(page.getByLabel('First name', { exact: true })).toBeFocused()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  // Only spaces satisfy the phone's check but not ours, so the page says what is needed in words.
  for (const label of ['First name', 'Last name', 'Contact number', 'Address']) await page.getByLabel(label, { exact: true }).fill(' ')
  await page.getByLabel('Email address', { exact: true }).fill('spaces@example.test')
  await next.click()
  await expect(page.getByRole('alert').filter({ hasText: 'Please fill in everything that is not marked optional.' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  const draft = await readDraft(page)
  await fixture.trackUser(draft.ownerUserId)
})

test('a phone number that cannot be right is named beside the field, before anything is reserved', async ({ page }) => {
  await toDuration(page)
  await chooseLength(page, 60)
  await page.getByLabel('Appointment date').fill(fixture.date)
  await page.getByRole('button', { name: '10:00', exact: true }).click()
  await page.getByRole('button', { name: 'Review booking', exact: true }).click()
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await page.getByRole('button', { name: 'Continue as guest' }).click()
  await page.getByLabel('First name', { exact: true }).fill('Check')
  await page.getByLabel('Last name', { exact: true }).fill('Details')
  await page.getByLabel('Email address', { exact: true }).fill(`check-${crypto.randomUUID()}@example.test`)
  await page.getByRole('textbox', { name: 'Address', exact: true }).fill('3 Check Road, London, SW1A 2AA')
  const phone = page.getByLabel('Contact number', { exact: true })
  await phone.fill('12345')
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await expect(page.getByText("That number doesn't look right")).toBeVisible()
  await expect(phone).toHaveAttribute('aria-invalid', 'true')
  await expect(phone).toBeFocused()
  await expect(page.getByRole('heading', { name: 'Your details', exact: true })).toBeVisible()
  // Typing in the field takes the message away, and the booking goes on.
  await phone.fill('07700 900654')
  await expect(page.getByText("That number doesn't look right")).toHaveCount(0)
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await expect(page.getByRole('heading', { name: 'One last step' })).toBeVisible()
  // Now a client and a reservation exist, so the clean-up has something to remove.
  await fixture.trackUser((await readDraft(page)).ownerUserId)
})

test('the postcode has a box of its own and is needed to continue; a whole address can still be pasted in one go', async ({ page }) => {
  await toDuration(page)
  await chooseLength(page, 60)
  await page.getByLabel('Appointment date').fill(fixture.date)
  await page.getByRole('button', { name: '10:00', exact: true }).click()
  await page.getByRole('button', { name: 'Review booking', exact: true }).click()
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await page.getByRole('button', { name: 'Continue as guest' }).click()
  await page.getByLabel('First name', { exact: true }).fill('Pasted')
  await page.getByLabel('Last name', { exact: true }).fill('Address')
  const email = `pasted-${crypto.randomUUID()}@example.test`
  await page.getByLabel('Email address', { exact: true }).fill(email)
  await page.getByLabel('Contact number', { exact: true }).fill('+44 7700 900655')
  const address = page.getByRole('textbox', { name: 'Address', exact: true })
  const postcode = page.getByRole('textbox', { name: 'Postcode', exact: true })
  const missing = page.getByText('Please enter your postcode, for example SW3 4LP.')
  await expect(address).toHaveAttribute('autocomplete', 'street-address')
  await expect(address).toHaveAttribute('maxlength', '400')
  await expect(postcode).toHaveAttribute('autocomplete', 'postal-code')
  await expect(page.getByText('The postcode goes in its own box below.')).toBeVisible()
  // No postcode anywhere: the booking stops, and says so beside the box.
  await address.fill('Flat 2\n14 Pasted Road\nLondon')
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await expect(missing).toBeVisible()
  await expect(postcode).toBeFocused()
  await expect(page.getByRole('heading', { name: 'One last step' })).toHaveCount(0)
  // A postcode in the address and a different one in the box: asked to make them the same.
  await address.fill('Flat 2\n14 Pasted Road\nLondon\nSW3 1AA')
  await postcode.fill('SW1A 1AA')
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await expect(page.getByText('Your address says SW3 1AA, but the postcode box says SW1A 1AA.')).toBeVisible()
  expect(await noSideways(page)).toBe(true)
  // In its own box, it is added to the end of the address.
  await address.fill('Flat 2\n14 Pasted Road\nLondon')
  await postcode.fill('sw3 1aa')
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  await expect(page.getByRole('heading', { name: 'One last step' })).toBeVisible()
  const client = (await unwrap(fixture.admin.from('clients').select('id,auth_user_id').eq('normalized_email', email)))[0]
  await fixture.trackUser(client.auth_user_id)
  // The line breaks became commas, in the booking and in the address kept for next time.
  await expect.poll(async () => (await unwrap(fixture.admin.from('bookings').select('address_snapshot').eq('client_id', client.id)))[0]?.address_snapshot).toBe('Flat 2, 14 Pasted Road, London, SW3 1AA')
  expect(await unwrap(fixture.admin.from('client_addresses').select('address').eq('client_id', client.id))).toEqual([{ address: 'Flat 2, 14 Pasted Road, London, SW3 1AA' }])
})

test('the bar at the bottom of the review is one row on phones from 360 to 430 px wide', async ({ page }) => {
  await toDuration(page)
  await chooseLength(page, 60)
  await page.getByLabel('Appointment date').fill(fixture.date)
  await page.getByRole('button', { name: '10:00', exact: true }).click()
  await page.getByRole('button', { name: 'Review booking', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review your booking' })).toBeVisible()
  for (const width of [360, 375, 390, 430]) {
    await page.setViewportSize({ width, height: 800 })
    const bar = await page.locator('.action-bar').boundingBox()
    expect(bar.height, `the bar at ${width}px`).toBeLessThan(120)
  }
})

test.describe('a double tap', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })
  test('lands on the screen it opened, not on a tile that appears under the finger', async ({ page }) => {
    await page.clock.install({ time: Date.now() })
    await page.goto('/')
    const area = page.locator('.tiles--areas .tile').first()
    await expect(area).toBeVisible()
    // Time stands still from here, so the moment after a screen has changed lasts as long as the test needs it to.
    await page.clock.pauseAt(Date.now() + 5000)
    await area.tap()
    await expect(page.getByRole('heading', { name: 'What would help you most today?' })).toBeVisible()
    // The second tap of a double tap arrives a moment after the screen has changed, on a treatment.
    const treatment = await page.locator('.tiles .tile').first().boundingBox()
    await page.touchscreen.tap(treatment.x + treatment.width / 2, treatment.y + treatment.height / 2)
    await page.waitForTimeout(300)
    await expect(page.getByRole('heading', { name: 'What would help you most today?' })).toBeVisible()
    expect((await readDraft(page)).serviceId).toBeFalsy()
    // Time moves on, the screen settles, and a tap works as it always did.
    await page.clock.runFor(500)
    await page.locator('.tiles .tile').first().tap()
    await expect(page.getByRole('heading', { name: 'How many people?' })).toBeVisible()
  })
})

test('the payment button explains why it is waiting, and a technical error never reaches the screen', async ({ page }) => {
  await toDuration(page)
  await chooseLength(page, 60)
  await page.getByLabel('Appointment date').fill(fixture.date)
  await page.getByRole('button', { name: '10:00', exact: true }).click()
  await page.getByRole('button', { name: 'Review booking', exact: true }).click()
  await page.route('**/rpc/quote_client_booking', route => route.fulfill({ status: 500, json: { code: 'XX000', message: 'connection to server at "10.1.2.3" failed' } }))
  await page.getByLabel(/Integration enhancement/).check()
  await expect(page.getByText("I couldn't update the price just now.")).toBeVisible()
  await expect(page.getByText('10.1.2.3')).toHaveCount(0)
  await page.unroute('**/rpc/quote_client_booking')
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.locator('.prices-total dd')).toHaveText('£115.00')
})
