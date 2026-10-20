import { test, expect } from '@playwright/test'
import { chooseLength } from '../bookingSteps.js'
import { localFixture } from '../localSupabase.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'
import { addDays } from '../../src/client/booking/dateStrip.js'

// A first appointment at a set time can be released: if nobody has booked it by the release time on the day before, the day opens to
// every usual time. Both days here are released at midnight on the day before, so tomorrow was released at the start of today and the
// day after tomorrow is released at the start of tomorrow, whatever time of day this runs. The 2-hour notice period never reaches
// tomorrow's 10:00, so it cannot change what is offered.
let fixture, second, secondBefore
test.beforeEach(async () => {
  fixture = await localFixture(1)
  second = addDays(fixture.date, 1)
  secondBefore = await unwrap(fixture.admin.from('working_hours_overrides').select('*').eq('date', second))
})
test.afterEach(async ({ page }) => {
  if (fixture && page.url().startsWith('http://127.0.0.1:5174')) fixture.trackKey(await page.evaluate(() => localStorage.getItem('vad-v2-hold-client-v1')))
  if (secondBefore?.length) await fixture?.admin.from('working_hours_overrides').upsert(secondBefore)
  else await fixture?.admin.from('working_hours_overrides').delete().eq('date', second)
  await fixture?.cleanup()
})

const firstAppointmentAtThree = release => ({ available: true, start_minutes: 600, end_minutes: 1320, start_mode: 'fixed', fixed_start_minutes: 900, anchor_release_minutes: release })

test('a day nobody has booked opens to every usual time once it is released, and until then offers only its first appointment', async ({ page }) => {
  for (const date of [fixture.date, second]) {
    const booked = await unwrap(fixture.admin.from('bookings').select('id').eq('date', date)
      .in('booking_status', ['awaiting_transfer', 'awaiting_payment_verification', 'awaiting_cash_approval', 'confirmed', 'completed']))
    expect(booked, `a booking on ${date} would make that day a chain and hide the release`).toHaveLength(0)
  }
  await unwrap(fixture.admin.from('working_hours_overrides').upsert([
    { date: fixture.date, ...firstAppointmentAtThree(0) },
    { date: second, ...firstAppointmentAtThree(0) },
  ], { onConflict: 'date' }))
  await page.goto('/')
  await page.getByRole('button', { name: /Integration area/ }).click()
  await page.getByRole('button', { name: /Integration massage/ }).click()
  await chooseLength(page, 60)

  // Released: any usual time between 10:00 and the last that finishes by 22:00, not just the first appointment.
  await page.getByLabel('Appointment date').fill(fixture.date)
  await expect(page.getByRole('button', { name: '21:00', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '10:00', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '15:00', exact: true })).toBeVisible()
  await expect(page.locator('.slots button')).toHaveCount(23)

  // Not released yet: only the first appointment.
  await page.getByLabel('Appointment date').fill(second)
  await expect(page.getByRole('button', { name: '15:00', exact: true })).toBeVisible()
  await expect(page.locator('.slots button')).toHaveCount(1)
})

test('without a release time the first appointment is kept until someone books, as it was before', async ({ page }) => {
  await unwrap(fixture.admin.from('working_hours_overrides').upsert({ date: fixture.date, ...firstAppointmentAtThree(null) }, { onConflict: 'date' }))
  await page.goto('/')
  await page.getByRole('button', { name: /Integration area/ }).click()
  await page.getByRole('button', { name: /Integration massage/ }).click()
  await chooseLength(page, 60)
  await page.getByLabel('Appointment date').fill(fixture.date)
  await expect(page.getByRole('button', { name: '15:00', exact: true })).toBeVisible()
  await expect(page.locator('.slots button')).toHaveCount(1)
})
