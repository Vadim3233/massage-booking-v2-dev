import { test, expect } from '@playwright/test'
import { chooseLength } from '../bookingSteps.js'
import { localFixture } from '../localSupabase.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'

// One booking at 15:00 on a day that works 10:00 to 22:00 (the fixture's hours). A chain day offers only the two ends of the day's run,
// 13:00 and 17:00; a flexible day offers every half hour with an hour of travel on both sides of the booking.
let fixture, bookingId
test.beforeEach(async () => { fixture = await localFixture(25) })
test.afterEach(async ({ page }) => {
  if (fixture && page.url().startsWith('http://127.0.0.1:5174')) fixture.trackKey(await page.evaluate(() => localStorage.getItem('vad-v2-hold-client-v1')))
  if (bookingId) await fixture?.admin.from('booking_payments').delete().eq('booking_id', bookingId)
  await fixture?.cleanup()
})

async function bookThreeOClock() {
  const [area] = await unwrap(fixture.admin.from('service_areas').select('id,name').eq('id', fixture.ids.area))
  bookingId = crypto.randomUUID()
  await unwrap(fixture.admin.from('bookings').insert({
    id: bookingId, booking_reference: `FLEX-${bookingId.slice(0, 8)}`, client_id: fixture.profile.client_id, service_area_id: area.id,
    date: fixture.date, start_minutes: 900, treatment_duration_minutes: 60, booking_status: 'confirmed', source_channel: 'test',
    address_snapshot: '10 Quiet Street, London, SW1A 1AA', service_area_name_snapshot: area.name,
    total_gbp: 85, service_subtotal_gbp: 85, booking_email_snapshot: fixture.email,
  }))
  await unwrap(fixture.admin.from('booking_payments').insert({ booking_id: bookingId, method: 'cash', status: 'approved', amount_gbp: 85 }))
}
const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
const every = (from, to) => Array.from({ length: (to - from) / 30 + 1 }, (_, index) => clock(from + index * 30))

for (const [mode, expected] of [
  ['chain', ['13:00', '17:00']],
  ['flexible', [...every(600, 780), ...every(1020, 1260)]],
]) {
  test(`a ${mode} day with a booking at 15:00 offers ${expected.length === 2 ? 'only the two ends of the day' : 'every time with room for travel, between appointments too'}`, async ({ page }) => {
    await bookThreeOClock()
    await unwrap(fixture.admin.from('working_hours_overrides').upsert({ date: fixture.date, available: true, start_minutes: 600, end_minutes: 1320, start_mode: 'flexible', fixed_start_minutes: null, schedule_mode: mode }, { onConflict: 'date' }))
    await page.goto('/')
    await page.getByRole('button', { name: /Integration area/ }).click()
    await page.getByRole('button', { name: /Integration massage/ }).click()
    await chooseLength(page, 60)
    await page.getByLabel('Appointment date').fill(fixture.date)
    await expect(page.locator('.slots button').first()).toBeVisible()
    await expect(page.locator('.slots button')).toHaveText(expected)
  })
}
