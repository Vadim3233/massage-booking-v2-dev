import { test, expect } from '@playwright/test'
import { paymentReviewFixture } from '../paymentReviewFixture.js'
import { localFixture } from '../localSupabase.js'

let f
const names = ['E2E Waiting Wendy', 'E2E Waiting Xavier']
test.afterEach(async () => {
  const requests = (await f?.admin.from('waitlist_requests').select('id').in('contact_name', names))?.data || []
  // Their events (and so their alerts) go too, so one test never sees another's.
  if (requests.length) await f.admin.from('event_outbox').delete().in('aggregate_id', requests.map(row => row.id))
  await f?.admin.from('waitlist_requests').delete().in('contact_name', names)
  await f?.cleanup()
})

const londonDay = offsetDays => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offsetDays * 86400000))

test.describe('the client leaves their details when a day is full', () => {
  test('a day with no times offers the waitlist, and the request reaches the database and the Admin', async ({ page }) => {
    f = await localFixture(25)
    const closedDay = londonDay(27)
    await f.admin.from('working_hours_overrides').upsert({ date: closedDay, available: false })
    try {
      await page.goto('/')
      await page.getByRole('button', { name: /Integration area/ }).click()
      await page.getByRole('button', { name: /Integration massage/ }).click()
      await page.getByRole('button', { name: 'Add 60 minutes', exact: true }).click()
      await page.getByRole('button', { name: 'Choose date & time' }).click()
      await page.getByLabel('Appointment date').fill(closedDay)
      await expect(page.getByText('No suitable times on this day.')).toBeVisible()
      const panel = page.locator('section.panel').filter({ hasText: 'Nothing free that day?' })
      await expect(panel).toBeVisible()
      await expect(panel.getByRole('button', { name: 'Add me to the waitlist' })).toBeDisabled()
      await panel.getByLabel('Your name').fill('E2E Waiting Wendy')
      await panel.getByLabel('Email').fill(`e2e-wait-${crypto.randomUUID()}@example.test`)
      await panel.getByLabel('Which time of day suits you?').selectOption('afternoon')
      await panel.getByRole('button', { name: 'Add me to the waitlist' }).click()
      await expect(page.getByRole('heading', { name: 'You are on the waitlist' })).toBeVisible()
      const row = (await f.admin.from('waitlist_requests').select('requested_date,preferred_from_minutes,preferred_to_minutes,duration_minutes,status').eq('contact_name', 'E2E Waiting Wendy').single()).data
      expect(row).toMatchObject({ requested_date: closedDay, preferred_from_minutes: 720, preferred_to_minutes: 1020, duration_minutes: 60, status: 'active' })
    } finally {
      await f.admin.from('working_hours_overrides').delete().eq('date', closedDay)
    }
  })

  test('a clash of times gives a kind message, not a technical one', async ({ page }) => {
    f = await localFixture(25)
    const closedDay = londonDay(27)
    await f.admin.from('working_hours_overrides').upsert({ date: closedDay, available: false })
    try {
      await page.goto('/')
      await page.getByRole('button', { name: /Integration area/ }).click()
      await page.getByRole('button', { name: /Integration massage/ }).click()
      await page.getByRole('button', { name: 'Add 60 minutes', exact: true }).click()
      await page.getByRole('button', { name: 'Choose date & time' }).click()
      await page.getByLabel('Appointment date').fill(closedDay)
      const panel = page.locator('section.panel').filter({ hasText: 'Nothing free that day?' })
      await panel.getByLabel('Your name').fill('E2E Waiting Wendy')
      await panel.getByLabel('Phone').fill('123')
      await panel.getByRole('button', { name: 'Add me to the waitlist' }).click()
      await expect(panel.getByRole('alert')).toHaveText('That phone number does not look right.')
    } finally {
      await f.admin.from('working_hours_overrides').delete().eq('date', closedDay)
    }
  })
})

test.describe('the Admin works the waitlist', () => {
  async function signIn(page, path) {
    await page.goto(path)
    await page.getByLabel('Email', { exact: true }).fill(f.email)
    await page.getByLabel('Password', { exact: true }).fill(f.password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  }
  async function addRequest(overrides = {}) {
    const day = londonDay(34)
    const { data, error } = await f.admin.from('waitlist_requests').insert({ contact_name: 'E2E Waiting Wendy', contact_phone: '07700 900321', requested_date: day, duration_minutes: 60, preferred_from_minutes: 0, preferred_to_minutes: 1440, ...overrides }).select().single()
    expect(error).toBeNull()
    return data
  }

  test('requests show their matches, can be offered, reopened and closed', async ({ page }) => {
    f = await paymentReviewFixture()
    await f.authorize()
    const request = await addRequest()
    await f.admin.from('working_hours_overrides').upsert({ date: request.requested_date, available: true, start_minutes: 600, end_minutes: 900, start_mode: 'flexible' })
    try {
      await signIn(page, '/admin/waitlist')
      const item = page.locator('.admin-waitlist-item').filter({ hasText: 'E2E Waiting Wendy' })
      await expect(item).toContainText('Any time of day · 60 min')
      await expect(item).toContainText('Could be booked now: 10:00, 10:30')
      await expect(item.getByRole('link', { name: 'WhatsApp' })).toHaveAttribute('href', 'https://wa.me/447700900321')
      await expect(item).toContainText('They have no client record yet.')
      await item.getByLabel('Your note (only you see this)').fill('Offered 11:00')
      await item.getByRole('button', { name: "I've offered a time" }).click()
      await expect(item).toContainText('You offered a time')
      await expect(item.getByLabel('Your note (only you see this)')).toHaveValue('Offered 11:00')
      await item.getByRole('button', { name: 'Not answered yet' }).click()
      await expect(item).not.toContainText('You offered a time')
      await item.getByRole('button', { name: 'No longer needed' }).click()
      await expect(page.getByText('Nobody is waiting right now.')).toBeVisible()
      await page.getByLabel('Show closed requests from the last 60 days').check()
      await expect(page.locator('.admin-waitlist-item').filter({ hasText: 'E2E Waiting Wendy' })).toContainText('Closed: no longer needed')
    } finally {
      await f.admin.from('working_hours_overrides').delete().eq('date', request.requested_date)
    }
  })

  test('a linked client can be booked straight from the request, and joining raises an alert that opens the waitlist', async ({ page }) => {
    f = await paymentReviewFixture()
    await f.authorize()
    const owner = (await f.admin.from('bookings').select('client_id').eq('id', f.bookings[2].id).single()).data.client_id
    const request = await addRequest({ client_id: owner })
    await f.admin.from('event_outbox').insert({ event_type: 'waitlist.joined', aggregate_type: 'waitlist', aggregate_id: request.id, payload: { from_minutes: 0, to_minutes: 1440, duration_minutes: 60 } })
    await signIn(page, '/admin/alerts')
    const alert = page.locator('.admin-alerts li').filter({ hasText: 'Someone joined the waitlist' })
    await expect(alert).toContainText('E2E Waiting Wendy')
    await alert.getByRole('button').click()
    await expect(page.getByRole('heading', { name: 'Waitlist', level: 1 })).toBeVisible()
    await page.locator('.admin-waitlist-item').filter({ hasText: 'E2E Waiting Wendy' }).getByRole('button', { name: 'Book for them' }).click()
    await expect(page.getByRole('heading', { name: 'New booking', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { pressed: true }).first()).toContainText('Alexandra')
  })
})
