import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'
import { shiftDate, today } from '../../src/admin/calendarPresentation.js'

// Every day in the Calendar says its working hours, exactly as the database works them out (admin_day_hours: its special day, or else the usual week),
// which is how the booking engine reads them. The fixture's own day (today plus 5) and the day after have special hours; today has the usual ones.
let f
test.beforeEach(async () => { f = await adminFixture(5) })
test.afterEach(async () => { await f?.cleanup() })

async function login(page, path) {
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
// The words the screens use for a day's hours (agendaDays.js cannot be loaded here: it brings the browser's database client with it).
const hhmm = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
const hoursText = row => {
  if (!row.available) return row.source === 'special' && row.note ? `Day off · ${row.note}` : 'Day off'
  const first = row.start_mode === 'fixed' ? `, first appointment at ${hhmm(row.fixed_start_minutes)}` : ''
  return `${row.source === 'special' ? 'Special hours' : 'Hours'} ${hhmm(row.start_minutes)}–${hhmm(row.end_minutes)}${first}`
}
// What the database says for these dates, asked as the Admin, the way the screens ask.
const hoursFor = async (from, to) => new Map((await unwrap(f.client.rpc('admin_day_hours', { p_from: from, p_to: to }))).map(row => [row.date, row]))
const daySection = (page, date) => page.locator('.admin-agenda-day', { has: page.locator(`[id="agenda-${date}"]`) })

test('the Agenda says each day\'s hours: usual hours plainly, special hours highlighted, and the free days too', async ({ page }) => {
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem('vad-admin-agenda-show-every', '1'))
  await login(page, '/admin/agenda')
  await expect(daySection(page, f.date)).toBeVisible()
  const hours = await hoursFor(today(), shiftDate(today(), 20))
  // Today, with its usual hours (or its day off), as a plain line.
  const todayHours = hours.get(today())
  const todayNote = page.locator('.admin-agenda-day.is-today .admin-agenda-notes li').last()
  await expect(todayNote).toHaveText(hoursText(todayHours))
  if (todayHours.source === 'usual' && todayHours.available) await expect(todayNote).toHaveClass(/is-usual/)
  // The fixture's day, with special hours, keeps its highlight.
  const special = daySection(page, f.date).locator('.admin-agenda-notes li').last()
  await expect(special).toHaveText(hoursText(hours.get(f.date)))
  await expect(special).toHaveClass(/is-special/)
  // A free day in between says its hours too, from the same answer.
  const free = page.locator('.admin-agenda-quiet li.is-free').first()
  await expect(free).toBeVisible()
  for (const item of await page.locator('.admin-agenda-quiet li.is-free').all()) await expect(item).toContainText(/free · \d\d:\d\d–\d\d:\d\d/)
  await page.screenshot({ path: 'test-results/agenda-day-hours.png', fullPage: true })
})

test('a special day off says its name, and the Day view says the same hours as the Agenda', async ({ page }) => {
  const off = shiftDate(f.date, 2)
  const before = await unwrap(f.admin.from('working_hours_overrides').select('*').eq('date', off))
  await unwrap(f.admin.from('working_hours_overrides').upsert({ date: off, available: false, start_minutes: null, end_minutes: null, start_mode: 'flexible', fixed_start_minutes: null, note: 'Christmas Holidays' }))
  try {
    await f.authorize()
    await page.setViewportSize({ width: 390, height: 844 })
    await login(page, '/admin/agenda')
    await expect(page.locator('.admin-agenda-quiet li.is-off', { hasText: 'Christmas Holidays' })).toHaveText(/Day off · Christmas Holidays/)
    const hours = await hoursFor(f.date, f.date)
    await page.goto('/admin/day')
    await page.getByLabel('Calendar date', { exact: true }).fill(f.date)
    await expect(page.locator('.admin-working-hours')).toHaveText(hoursText(hours.get(f.date)))
    await page.getByLabel('Calendar date', { exact: true }).fill(off)
    await expect(page.locator('.admin-working-hours')).toHaveText('Day off · Christmas Holidays')
  } finally {
    if (before.length) await unwrap(f.admin.from('working_hours_overrides').upsert(before))
    else await unwrap(f.admin.from('working_hours_overrides').delete().eq('date', off))
  }
})
