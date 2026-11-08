import { test, expect } from '@playwright/test'
import { chooseLength } from '../bookingSteps.js'
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

test.describe('the client asks about a time that is not free (ADR-095)', () => {
  // 10:00 to 12:00 with the first appointment at 11:00: only 11:00 is free, and 10:00, 10:30 and the evening hours after 12:00 are faded.
  async function openDay(page, day) {
    await page.goto('/')
    await page.getByRole('button', { name: /Integration area/ }).click()
    await page.getByRole('button', { name: /Integration massage/ }).click()
    await chooseLength(page, 60)
    await page.getByLabel('Appointment date').fill(day)
    await expect(page.getByRole('button', { name: '11:00', exact: true })).toBeVisible()
  }

  test('a faded time asks for a phone or email, and the request and the visit reach the database', async ({ page }) => {
    f = await localFixture(25)
    const day = londonDay(27)
    const email = `e2e-wanted-${crypto.randomUUID()}@example.test`
    await f.admin.from('working_hours_overrides').upsert({ date: day, available: true, start_minutes: 600, end_minutes: 720, start_mode: 'fixed', fixed_start_minutes: 660 })
    try {
      await openDay(page, day)
      // Full times are tucked away until asked for.
      await expect(page.getByRole('button', { name: '10:00, not available right now' })).toHaveCount(0)
      await page.getByRole('button', { name: /full times? — I can tell you if one frees up/ }).click()
      await expect(page.getByText("Full times aren't available right now.")).toBeVisible()
      await expect(page.getByRole('button', { name: '09:30, not available right now' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: '13:00, not available right now' })).toBeVisible()
      await page.getByRole('button', { name: '10:00, not available right now' }).click()
      const panel = page.getByRole('form', { name: /Ask about 10:00/ })
      await expect(panel).toContainText("isn't available, but in case anything changes, I can let you know.")
      await expect(panel.getByRole('button', { name: 'Yes, let me know' })).toBeDisabled()
      await panel.getByLabel('Your phone number (or email)').fill(email)
      await panel.getByRole('button', { name: 'Yes, let me know' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Thank you.' })).toContainText("If anything changes for")
      await expect(page.getByRole('button', { name: '10:00, not available right now, you asked to hear if anything changes' })).toBeVisible()
      const row = (await f.admin.from('waitlist_requests').select('contact_name,requested_date,preferred_from_minutes,preferred_to_minutes,duration_minutes').eq('contact_email', email).single()).data
      expect(row).toMatchObject({ contact_name: 'Visitor', requested_date: day, preferred_from_minutes: 600, preferred_to_minutes: 630, duration_minutes: 60 })
      await expect.poll(async () => {
        const rows = (await f.admin.from('visit_events').select('kind,detail').eq('detail->>date', day)).data || []
        return rows.map(item => item.kind).sort()
      }).toEqual(expect.arrayContaining(['asked', 'day', 'wanted']))
    } finally {
      const requests = (await f.admin.from('waitlist_requests').select('id').eq('contact_email', email)).data || []
      if (requests.length) await f.admin.from('event_outbox').delete().in('aggregate_id', requests.map(item => item.id))
      await f.admin.from('waitlist_requests').delete().eq('contact_email', email)
      await f.admin.from('working_hours_overrides').delete().eq('date', day)
    }
  })

  test('"None of these suit me" takes one tap', async ({ page }) => {
    f = await localFixture(25)
    const day = londonDay(27)
    await f.admin.from('working_hours_overrides').upsert({ date: day, available: true, start_minutes: 600, end_minutes: 720, start_mode: 'fixed', fixed_start_minutes: 660 })
    try {
      await openDay(page, day)
      await page.getByRole('button', { name: 'None of these suit me' }).click()
      const choices = page.getByRole('group', { name: /What would suit you/ })
      await choices.getByRole('button').first().click()
      await expect(page.getByText('Thanks, noted.')).toBeVisible()
    } finally {
      await f.admin.from('working_hours_overrides').delete().eq('date', day)
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
    await expect(page.getByRole('button', { name: 'Change client', exact: true })).toBeVisible()
    await expect(page.locator('.anb-block').first()).toContainText('Alexandra')
  })
})
