import { test, expect } from '@playwright/test'
import { localFixture } from '../localSupabase.js'

// Step 3, People & length (Vadim's change request 2): how many people first, then lengths that say who, how long and the price, with the
// area's fees in it; a different length for each person; and the way back to the number of people from the review.
let fixture
test.beforeEach(async () => { fixture = await localFixture(26) })
test.afterEach(async ({ page }) => {
  if (fixture && page.url().startsWith('http://127.0.0.1:5174')) fixture.trackKey(await page.evaluate(() => localStorage.getItem('vad-v2-hold-client-v1')))
  await fixture?.cleanup()
})
const readDraft = page => page.evaluate(() => JSON.parse(sessionStorage.getItem('vad-v2-booking-draft-v1')).draft)

test('people first, then lengths for that many, each saying how many people and the total price', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: /Integration area/ }).click()
  await page.getByRole('button', { name: /Integration massage/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'How many people?' })).toBeFocused()
  for (const name of [/^Just me/, /^2 people/, /^3 people/, /^4 people/]) await expect(page.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false')
  await page.screenshot({ path: 'test-results/people-step.png', fullPage: true })
  await page.getByRole('button', { name: /^2 people/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'How long for 2 people?' })).toBeVisible()
  // The test area adds its fees to every option, so the price is the whole visit's.
  const option = page.getByRole('button', { name: /^60 minutes · 2 people, 2 hours in total · £\d+\.\d\d$/ })
  await expect(option).toBeVisible()
  await expect(option).toContainText('2 people × 60 min')
  await expect(option).toContainText('One after the other · 2 hours in total')
  await expect(page.getByText(/^Prices include the Integration area travel fee \(£\d+\.\d\d\) and congestion charge \(£\d+\.\d\d\)\.$/)).toBeVisible()
  await page.screenshot({ path: 'test-results/people-lengths.png', fullPage: true })
  // A different length for each person, never over four hours.
  await page.getByRole('button', { name: 'Different length for each person' }).click()
  await page.getByRole('group', { name: 'Person 2' }).getByRole('button', { name: '90 min' }).click()
  await expect(page.locator('.total-line b')).toHaveText('Two massages for 2 people, one after the other (60 min + 90 min) – 2 hours 30 minutes in total')
  await page.getByRole('group', { name: 'Person 1' }).getByRole('button', { name: '2 hours' }).click()
  // Two people at 2 hours each is exactly the four hours a visit can hold.
  await expect(page.getByRole('group', { name: 'Person 2' }).getByRole('button', { name: '2 hours' })).toBeEnabled()
  await page.screenshot({ path: 'test-results/people-each.png', fullPage: true })
  await page.getByRole('button', { name: 'Choose date & time' }).click()
  await expect(page.getByRole('heading', { name: 'Choose date and time' })).toBeVisible()
  expect((await readDraft(page)).sessions.map(session => session.duration_minutes)).toEqual([120, 90])
})

test('three people can only have 60 minutes each, and four people too', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /Integration area/ }).click()
  await page.getByRole('button', { name: /Integration massage/ }).click()
  await page.getByRole('button', { name: /^3 people/ }).click()
  await expect(page.locator('.tile--length')).toHaveCount(1)
  await expect(page.getByRole('button', { name: /^60 minutes · 3 people, 3 hours in total/ })).toBeVisible()
  // A different length for each: once the visit is full, a longer session for anyone is not offered.
  await page.getByRole('button', { name: 'Different length for each person' }).click()
  await page.getByRole('group', { name: 'Person 1' }).getByRole('button', { name: '2 hours' }).click()
  await expect(page.getByRole('group', { name: 'Person 2' }).getByRole('button', { name: '90 min' })).toBeDisabled()
  await page.getByRole('button', { name: 'Same length for everyone' }).click()
  await page.getByRole('button', { name: 'Change number of people' }).click()
  await page.getByRole('button', { name: /^4 people/ }).click()
  await expect(page.locator('.tile--length')).toHaveCount(1)
  await page.getByRole('button', { name: /^60 minutes · 4 people, 4 hours in total/ }).click()
  expect((await readDraft(page)).sessions.map(session => session.duration_minutes)).toEqual([60, 60, 60, 60])
})

test('Change number of people on the review goes back to the question, keeping the place and treatment', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /Integration area/ }).click()
  await page.getByRole('button', { name: /Integration massage/ }).click()
  await page.getByRole('button', { name: /^Just me/ }).click()
  await page.getByRole('button', { name: /^120 minutes/ }).click()
  await page.getByLabel('Appointment date').fill(fixture.date)
  await page.getByRole('button', { name: '10:00', exact: true }).click()
  await page.getByRole('button', { name: 'Review booking', exact: true }).click()
  await expect(page.locator('.people-sentence strong')).toHaveText(/^One 2-hour massage for 1 person – £\d+\.\d\d$/)
  await page.screenshot({ path: 'test-results/people-review.png', fullPage: true })
  const before = await readDraft(page)
  await page.getByRole('button', { name: 'Change number of people' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'How many people?' })).toBeVisible()
  const after = await readDraft(page)
  expect([after.areaId, after.serviceId]).toEqual([before.areaId, before.serviceId])
})
