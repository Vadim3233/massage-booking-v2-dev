import { test, expect } from '@playwright/test'
import { localFixture } from '../localSupabase.js'

// An area's minimum booking (Vadim, 5 Nov 2026): shorter visits are greyed out with the reason, and two people's times add up.
let fixture
test.beforeEach(async () => { fixture = await localFixture(27) })
test.afterEach(async ({ page }) => {
  if (fixture && page.url().startsWith('http://127.0.0.1:5174')) fixture.trackKey(await page.evaluate(() => localStorage.getItem('vad-v2-hold-client-v1')))
  await fixture?.cleanup()
})

test('lengths under the area minimum are greyed out, and a couple of an hour each reach two hours', async ({ page }) => {
  const { error } = await fixture.admin.from('service_areas').update({ minimum_booking_minutes: 120 }).eq('id', fixture.ids.area)
  expect(error).toBeNull()
  await page.goto('/')
  await page.getByRole('button', { name: /Integration area/ }).click()
  await page.getByRole('button', { name: /Integration massage/ }).click()
  await expect(page.getByText('In Integration area the minimum booking is 2 hours in total. Two people\'s times add up.')).toBeVisible()
  await page.getByRole('button', { name: /^Just me/ }).click()
  const hour = page.getByRole('button', { name: /^60 minutes · 1 person · £\d+\.\d\d · under the 2 hours minimum here$/ })
  await expect(hour).toBeDisabled()
  await expect(hour).toContainText('Under the 2 hours minimum here')
  await page.screenshot({ path: 'test-results/area-minimum-one.png', fullPage: true })
  await page.getByRole('button', { name: 'Change number of people' }).click()
  await page.getByRole('button', { name: /^2 people/ }).click()
  await expect(page.getByRole('button', { name: /^60 minutes · 2 people, 2 hours in total · £\d+\.\d\d$/ })).toBeEnabled()
  await page.screenshot({ path: 'test-results/area-minimum-two.png', fullPage: true })
})
