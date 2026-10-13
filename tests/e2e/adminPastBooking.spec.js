import { test, expect } from '@playwright/test'
import { newBookingFixture } from '../newBookingFixture.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'
import { shiftDate, today } from '../../src/admin/calendarPresentation.js'
import { dayInWords } from '../../src/admin/newBooking/presentation.js'

// The Admin records an appointment that has already happened: completed straight away if it is paid (after one more question), confirmed if not,
// and nobody is told.
let f
test.beforeEach(async () => { f = await newBookingFixture(41) })
test.afterEach(async () => { await f?.cleanup() })

const pastDay = shiftDate(today(), -6)
// An appointment made the way the Admin's own screen makes it, for a day that has gone.
const request = (date, start, payment = 'bank_received') => ({
  client_id: f.recipient.id, saved_address_id: f.addresses[0].id, service_area_id: f.ids.area,
  sessions: [{ service_id: f.ids.service, duration_minutes: 60, recipient_name: 'Someone', preference_ids: [] }],
  enhancement_ids: [], date, start_minutes: start, payment_arrangement: payment, note: null, past: true,
})
const record = (date, start, payment) => unwrap(f.client.rpc('admin_create_booking', { p_request_id: crypto.randomUUID(), p_request: request(date, start, payment) }))

async function newBooking(page, calendarDate = f.date) {
  await page.goto('/admin/day')
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: '+ New booking', exact: true })).toBeVisible()
  await page.getByLabel('Calendar date', { exact: true }).fill(calendarDate)
  await page.getByRole('button', { name: '+ New booking', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'New booking', exact: true })).toBeVisible()
  await page.getByLabel('Find a client').fill(f.recipient.email)
  await page.getByRole('button', { name: new RegExp(f.recipient.first_name) }).click()
  await expect(page.getByRole('radio', { name: /10 Saved Street/ })).toBeChecked()
  await page.getByRole('combobox', { name: 'Service area', exact: true }).selectOption(f.ids.area)
  await page.getByRole('radio', { name: 'Integration massage', exact: true }).check()
}
const toggle = page => page.getByRole('checkbox', { name: 'It has already happened' })
const past = page => page.locator('.anb-past')
const chip = (page, label) => past(page).getByRole('button', { name: new RegExp(`^${label}( |$)`) })
const rowsOf = () => unwrap(f.admin.from('bookings').select('date,start_minutes,booking_status,source_channel,booking_payments(method,status)').eq('client_id', f.recipient.id).order('start_minutes'))
const deliveries = async () => {
  const ids = (await unwrap(f.admin.from('bookings').select('id').eq('client_id', f.recipient.id))).map(row => row.id)
  return ids.length ? (await unwrap(f.admin.from('notification_deliveries').select('id, event_outbox!inner(aggregate_id)').in('event_outbox.aggregate_id', ids))).length : 0
}
// The time in London now, and the half hour that has just begun (kept so that an hour's appointment from it still ends by midnight).
const londonMinutes = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value])); return Number(p.hour) * 60 + Number(p.minute) }
const currentHalfHour = () => Math.min(Math.floor(londonMinutes() / 30) * 30, 1380)
const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

test('an appointment that has already happened is recorded as completed when it is paid, after one more question, and nobody is told', async ({ page }) => {
  await newBooking(page)
  // Off to begin with, and the usual page is unchanged.
  await expect(toggle(page)).not.toBeChecked()
  await expect(page.getByText('Putting an appointment in the diary after the fact?')).toBeVisible()
  await expect(page.getByLabel('Appointment date')).toHaveValue(f.date)
  await toggle(page).check()
  await expect(page.getByLabel('Day it happened')).toHaveValue(shiftDate(today(), -1))
  await expect(page.getByLabel('Appointment date')).toHaveCount(0)
  await page.getByLabel('Day it happened').fill(pastDay)
  // The day is named in full, with its year, so there is no doubt which one was chosen.
  await expect(past(page).locator('.day-name')).toHaveText(dayInWords(pastDay))
  await expect(chip(page, '06:00')).toBeVisible()
  await expect(chip(page, '23:00')).toBeVisible()
  await expect(chip(page, '23:30')).toHaveCount(0)
  await expect(past(page)).toContainText('Nothing was in your diary that day.')
  await chip(page, '10:00').click()
  await expect(chip(page, '10:00')).toHaveAttribute('aria-pressed', 'true')
  // What can be chosen for something that has happened: paid either way, or not paid yet either way; never "at the appointment", never a repeat.
  for (const name of ['Paid by bank transfer', 'Paid in cash', 'Not paid yet — bank transfer', 'Not paid yet — cash']) await expect(page.getByRole('radio', { name, exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: /Cash — at appointment/ })).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Repeat' })).toHaveCount(0)
  await expect(page.getByText('A repeating booking cannot start with an appointment that has already happened.')).toBeVisible()
  await page.getByRole('radio', { name: 'Paid by bank transfer', exact: true }).check()
  await expect(page.locator('.anb-summary')).toContainText('Paid by bank transfer. It will be recorded as completed, and the client is not emailed.')
  await expect(page.locator('.anb-summary')).toContainText('10:00–11:00')
  await expect(page.locator('.anb-summary')).toContainText(`${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric' }).format(new Date(`${pastDay}T12:00:00Z`))}`)
  // A paid one is final, so she is asked once more, with who, which day (and year), when, how much and that it cannot be changed from here.
  let asked = ''
  page.once('dialog', dialog => { asked = dialog.message(); dialog.accept() })
  await page.getByRole('button', { name: 'Record booking', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(asked).toContain('Record this as completed and paid?')
  expect(asked).toContain(`${f.recipient.first_name} ${f.recipient.last_name}`)
  expect(asked).toContain(`${dayInWords(pastDay)}, 10:00–11:00`)
  expect(asked).toMatch(/£\d+\.\d\d, paid by bank transfer/)
  expect(asked).toContain('A completed appointment cannot be cancelled or changed from here')
  expect(await rowsOf()).toEqual([{ date: pastDay, start_minutes: 600, booking_status: 'completed', source_channel: 'admin', booking_payments: { method: 'bank_transfer', status: 'paid' } }])
  expect(await deliveries()).toBe(0)
})

test('saying no to the question records nothing, and she can change her mind about the client or the day', async ({ page }) => {
  await newBooking(page)
  await toggle(page).check()
  await page.getByLabel('Day it happened').fill(pastDay)
  await chip(page, '10:00').click()
  await page.getByRole('radio', { name: 'Paid in cash', exact: true }).check()
  page.once('dialog', dialog => dialog.dismiss())
  await page.getByRole('button', { name: 'Record booking', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'New booking', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await rowsOf()).toEqual([])
  // Still all there: the same day and time, ready to be changed or recorded.
  await expect(chip(page, '10:00')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Record booking', exact: true })).toBeEnabled()
  // Choosing another day and recording that one, answering yes.
  await page.getByLabel('Day it happened').fill(shiftDate(today(), -8))
  await chip(page, '14:00').click()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Record booking', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(await rowsOf()).toEqual([{ date: shiftDate(today(), -8), start_minutes: 840, booking_status: 'completed', source_channel: 'admin', booking_payments: { method: 'cash', status: 'paid' } }])
})

test('one that is not paid yet stays confirmed, with no question, and nobody is told either', async ({ page }) => {
  await newBooking(page)
  await toggle(page).check()
  await page.getByLabel('Day it happened').fill(pastDay)
  await chip(page, '14:00').click()
  await page.getByRole('radio', { name: 'Not paid yet — bank transfer', exact: true }).check()
  await expect(page.locator('.anb-summary')).toContainText('Not paid yet — bank transfer. It will be recorded as confirmed, and you can complete it once it is paid. The client is not emailed.')
  let asked = false
  page.on('dialog', dialog => { asked = true; dialog.dismiss() })
  await page.getByRole('button', { name: 'Record booking', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(asked).toBe(false)
  expect(await rowsOf()).toEqual([{ date: pastDay, start_minutes: 840, booking_status: 'confirmed', source_channel: 'admin', booking_payments: { method: 'bank_transfer', status: 'awaiting_transfer' } }])
  expect(await deliveries()).toBe(0)
})

test('not paid yet can be cash too, so that when the cash comes it is recorded as cash', async ({ page }) => {
  await newBooking(page)
  await toggle(page).check()
  await page.getByLabel('Day it happened').fill(pastDay)
  await chip(page, '16:00').click()
  await page.getByRole('radio', { name: 'Not paid yet — cash', exact: true }).check()
  await expect(page.locator('.anb-summary')).toContainText('Not paid yet — cash. It will be recorded as confirmed')
  await page.getByRole('button', { name: 'Record booking', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(await rowsOf()).toEqual([{ date: pastDay, start_minutes: 960, booking_status: 'confirmed', source_channel: 'admin', booking_payments: { method: 'cash', status: 'approved' } }])
  expect(await deliveries()).toBe(0)
})

test('a time that overlaps what was already in the diary is greyed, and says what it clashes with', async ({ page }) => {
  await record(pastDay, 600)
  await newBooking(page)
  await toggle(page).check()
  await page.getByLabel('Day it happened').fill(pastDay)
  await expect(past(page)).toContainText('In your diary that day: 10:00–11:00')
  await expect(chip(page, '10:30')).toHaveAttribute('aria-disabled', 'true')
  await expect(chip(page, '11:00')).not.toHaveAttribute('aria-disabled', 'true')
  await expect(past(page).getByRole('button', { name: '10:30 overlaps another appointment', exact: true })).toBeVisible()
  await chip(page, '10:30').click({ force: true })
  await expect(past(page).locator('.anb-time-note')).toHaveText(/^Clashes with the 10:00–11:00 appointment for /)
  await expect(chip(page, '10:30')).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: 'Record booking', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Choose the day and time it happened.')
  expect(await rowsOf()).toHaveLength(1)
  // Straight after it is fine, and choosing it takes the note away.
  await chip(page, '11:00').click()
  await expect(past(page).locator('.anb-time-note')).toHaveCount(0)
  await expect(chip(page, '11:00')).toHaveAttribute('aria-pressed', 'true')
  // The note belongs to the day it was tapped on: another day does not carry it, and going back to the first day does not bring it back.
  await chip(page, '10:30').click({ force: true })
  await expect(past(page).locator('.anb-time-note')).toHaveText(/^Clashes with the 10:00–11:00 appointment for /)
  await page.getByLabel('Day it happened').fill(shiftDate(today(), -8))
  await expect(past(page).locator('.day-name')).toHaveText(dayInWords(shiftDate(today(), -8)))
  await expect(past(page)).toContainText('Nothing was in your diary that day.')
  await expect(chip(page, '10:30')).not.toHaveAttribute('aria-disabled', 'true')
  await expect(past(page).locator('.anb-time-note')).toHaveCount(0)
  await page.getByLabel('Day it happened').fill(pastDay)
  await expect(past(page)).toContainText('In your diary that day: 10:00–11:00')
  await expect(past(page).locator('.anb-time-note')).toHaveCount(0)
})

test('it looks as the usual picker does: times in a grid, and the chosen one filled in', async ({ page }) => {
  await newBooking(page)
  await toggle(page).check()
  await page.getByLabel('Day it happened').fill(pastDay)
  await expect(past(page).locator('.slots').first()).toHaveCSS('display', 'grid')
  await expect(past(page).locator('.date-field')).toHaveCSS('max-width', '240px')
  // The colour the chosen time should fade to: the brand colour, as the page itself resolves it (the buttons fade, so the check waits for the end).
  const primary = await page.evaluate(() => {
    const probe = document.createElement('i')
    probe.style.color = 'var(--primary)'
    document.body.append(probe)
    const value = getComputedStyle(probe).color
    probe.remove()
    return value
  })
  const other = await chip(page, '09:00').evaluate(el => getComputedStyle(el).backgroundColor)
  expect(other).not.toBe(primary)
  await chip(page, '10:00').click()
  await expect(chip(page, '10:00')).toHaveCSS('background-color', primary)
  await expect(chip(page, '09:00')).toHaveCSS('background-color', other)
})

test('turning it off goes back to today and the usual times, and a payment chosen for something that happened is not carried into a booking for the future', async ({ page }) => {
  await newBooking(page)
  // A time already chosen for the future is not carried to the day that has gone: it has to be chosen again, on purpose.
  await page.getByRole('group', { name: 'Available times' }).getByRole('button').first().click()
  await expect(page.locator('.anb-summary')).not.toContainText('Choose a time above')
  await page.getByRole('radio', { name: /Cash — at appointment/ }).check()
  await toggle(page).check()
  await expect(chip(page, '10:00')).toBeVisible()
  await expect(past(page).locator('.slots button[aria-pressed="true"]')).toHaveCount(0)
  await expect(page.locator('.anb-summary')).toContainText('Choose a time above')
  // Cash still to be paid is "not paid yet — cash" for something that happened.
  await expect(page.getByRole('radio', { name: 'Not paid yet — cash', exact: true })).toBeChecked()
  await page.getByRole('radio', { name: 'Paid by bank transfer', exact: true }).check()
  await chip(page, '10:00').click()
  await toggle(page).uncheck()
  await expect(page.getByLabel('Day it happened')).toHaveCount(0)
  await expect(page.getByLabel('Appointment date')).toHaveValue(today())
  await expect(page.getByRole('radio', { name: /Bank transfer — payment pending/ })).toBeChecked()
  await expect(page.getByRole('radio', { name: /Cash — at appointment/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create booking', exact: true })).toBeVisible()
  // The time chosen for the day that had gone is not kept either.
  await expect(page.locator('.anb-summary')).toContainText('Choose a time above')
})

test('if the database has not been updated for this yet, she is told in words, never in field names or codes, and nothing is recorded', async ({ page }) => {
  // The screen can reach a live site a little before the database is updated (or after an update is taken back).
  await page.route('**/rest/v1/rpc/admin_past_booking_times', route => route.fulfill({ status: 404, contentType: 'application/json',
    body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.admin_past_booking_times(p_date, p_treatment_duration_minutes) in the schema cache', details: null, hint: null }) }))
  await newBooking(page)
  await toggle(page).check()
  await page.getByLabel('Day it happened').fill(pastDay)
  const alert = past(page).getByRole('alert')
  await expect(alert).toContainText('Recording an appointment that has already happened is not ready yet.')
  await expect(alert).not.toContainText('PGRST202')
  await expect(alert).not.toContainText('schema cache')
  await expect(alert.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
  await expect(past(page).locator('.slots button')).toHaveCount(0)
  expect(await rowsOf()).toEqual([])
})

test('if the database does not know about "past" when she records one, the message is in words, nothing is recorded, and she can try again', async ({ page }) => {
  await page.route('**/rest/v1/rpc/admin_create_booking', route => route.fulfill({ status: 400, contentType: 'application/json',
    body: JSON.stringify({ code: '22023', message: 'Unsupported booking fields', details: null, hint: null }) }))
  await newBooking(page)
  await toggle(page).check()
  await page.getByLabel('Day it happened').fill(pastDay)
  await chip(page, '10:00').click()
  await page.getByRole('radio', { name: 'Not paid yet — bank transfer', exact: true }).check()
  await page.getByRole('button', { name: 'Record booking', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Recording an appointment that has already happened is not ready yet.')
  expect(await rowsOf()).toEqual([])
  await expect(page.getByRole('button', { name: 'Record booking', exact: true })).toBeEnabled()
  await expect(chip(page, '10:00')).toHaveAttribute('aria-pressed', 'true')
})

test('opening New booking from a day that has gone starts as "already happened" for that day', async ({ page }) => {
  await newBooking(page, pastDay)
  await expect(toggle(page)).toBeChecked()
  await expect(page.getByLabel('Day it happened')).toHaveValue(pastDay)
  await expect(page.getByRole('button', { name: 'Record booking', exact: true })).toBeVisible()
})

test('the day it happened is limited to the last year, and today lists exactly the times that have begun', async ({ page }) => {
  await newBooking(page)
  await toggle(page).check()
  const day = page.getByLabel('Day it happened')
  await expect(day).toHaveAttribute('max', today())
  await expect(day).toHaveAttribute('min', shiftDate(today(), -365))
  // A day typed in from outside that year, or one still to come, is ignored: the day stays as it was.
  await day.fill(shiftDate(today(), -2))
  await expect(day).toHaveValue(shiftDate(today(), -2))
  await day.fill(shiftDate(today(), -400))
  await expect(day).toHaveValue(shiftDate(today(), -2))
  await day.fill(shiftDate(today(), 3))
  await expect(day).toHaveValue(shiftDate(today(), -2))
  const before = currentHalfHour()
  await day.fill(today())
  if (before < 360) {
    // Nothing of today has begun before 06:00.
    await expect(past(page).getByText('No time of that day has begun yet.')).toBeVisible()
    await expect(past(page).locator('.slots button')).toHaveCount(0)
  } else {
    await expect(chip(page, '06:00')).toBeVisible()
    const labels = await past(page).locator('.slots button').allInnerTexts()
    const after = currentHalfHour()
    // Every half hour from 06:00 up to the one that has just begun, and none after it.
    expect(labels.length).toBeGreaterThan(0)
    expect([clock(before), clock(after)]).toContain(labels.at(-1).slice(0, 5))
    expect(labels.map(label => label.slice(0, 5))).toEqual(Array.from({ length: (Number.parseInt(labels.at(-1).slice(0, 2), 10) * 60 + Number.parseInt(labels.at(-1).slice(3, 5), 10) - 360) / 30 + 1 }, (_, i) => clock(360 + i * 30)))
  }
})

test('while a client is part-way through booking today it says so, and lists their held time as theirs', async ({ page }) => {
  await unwrap(f.admin.from('booking_holds').insert({ date: today(), start_minutes: 1380, treatment_duration_minutes: 60, travel_buffer_minutes: 60, status: 'active',
    expires_at: new Date(Date.now() + 10 * 60000).toISOString(), client_key: f.key() }))
  await newBooking(page)
  await toggle(page).check()
  await page.getByLabel('Day it happened').fill(today())
  await expect(past(page).getByText('A client is in the middle of booking this day. Try again in a few minutes.')).toBeVisible()
  await expect(past(page)).toContainText('(a client is booking)')
  await expect(past(page)).not.toContainText('an appointment')
})

test('the page fits a phone and a very small phone', async ({ page }) => {
  await newBooking(page)
  await toggle(page).check()
  await page.getByLabel('Day it happened').fill(pastDay)
  await chip(page, '10:00').click()
  for (const [width, height] of [[390, 844], [320, 700]]) {
    await page.setViewportSize({ width, height })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  }
})
