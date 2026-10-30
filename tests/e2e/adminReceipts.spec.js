import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

let f
const CREDENTIALS = { practitioner_name: 'Vadim Susarin', practitioner_title: 'Level 5 Soft Tissue Therapist', association: 'Institute for Soft Tissue Therapists (ISRM)', membership_number: '9555' }
const DETAILS = { name: 'VadMassage', phone: '07700 900123', email: 'hello@vadmassage.example', address: '1 Example Street\nLondon', closing: 'Thank you.', ...CREDENTIALS }
// The receipts, their history, the numbers and her details are cleared around every test: the booking cannot be deleted while it has a receipt.
async function clear() {
  const ids = f.bookings.map(row => row.id)
  const receipts = (await f.admin.from('booking_receipts').select('id').in('booking_id', ids)).data ?? []
  if (receipts.length) await f.admin.from('booking_receipt_revisions').delete().in('receipt_id', receipts.map(row => row.id))
  await f.admin.from('booking_receipts').delete().in('booking_id', ids)
  await f.admin.from('event_outbox').delete().in('aggregate_id', ids)
  await f.admin.from('business_settings').delete().eq('key', 'receipt_details')
  await f.admin.from('receipt_counters').delete().neq('year', 0)
}
test.beforeEach(async () => { f = await adminFixture(43); await clear() })
test.afterEach(async () => { await clear(); await f?.cleanup() })

const year = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric' }).format(new Date())
const saveDetails = (value = DETAILS) => unwrap(f.admin.from('business_settings').upsert({ key: 'receipt_details', value }))
const markPaid = id => unwrap(f.admin.from('booking_payments').update({ status: 'paid', paid_at: new Date(Date.now() - 86400000).toISOString() }).eq('booking_id', id))
async function signIn(page, path) {
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
const card = page => page.getByRole('article', { name: /^Receipt VAD-/ })
const receiptButton = page => page.getByRole('button', { name: 'Receipt', exact: true })
const queued = async id => (await unwrap(f.admin.from('event_outbox').select('notification_deliveries(recipient,title,body)').eq('aggregate_id', id).eq('event_type', 'booking.receipt_emailed'))).flatMap(row => row.notification_deliveries)

test('her receipt details are asked for, checked and kept', async ({ page }) => {
  await f.authorize()
  await signIn(page, '/admin/more')
  await page.getByRole('link', { name: 'Receipt details' }).click()
  await expect(page.getByRole('heading', { name: 'Receipt details', level: 1 })).toBeVisible()
  await expect(page.getByText('Nothing is saved here yet.')).toBeVisible()
  await page.getByLabel('Business name').fill('VadMassage')
  await expect(page.getByText('Add a phone number, an email address or a website.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save receipt details' })).toBeDisabled()
  await page.getByLabel('Email').fill('hello-at-example')
  await expect(page.getByText('That email address does not look right.')).toBeVisible()
  await page.getByLabel('Email').fill('Hello@VadMassage.example')
  await page.getByLabel('Address (optional)').fill('1 Example Street\nLondon')
  await page.getByLabel(/A closing line/).fill('Thank you.')
  await expect(page.getByText('Add your full name, professional association and membership number.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save receipt details' })).toBeDisabled()
  await page.getByLabel('Your full name').fill(CREDENTIALS.practitioner_name)
  await page.getByLabel('Professional title (optional)').fill(CREDENTIALS.practitioner_title)
  await page.getByLabel('Professional association').fill(CREDENTIALS.association)
  await page.getByLabel('Membership number').fill(CREDENTIALS.membership_number)
  await page.getByRole('button', { name: 'Save receipt details' }).click()
  await expect(page.getByText('Saved. New receipts will use these details.')).toBeVisible()
  const stored = (await unwrap(f.admin.from('business_settings').select('value').eq('key', 'receipt_details').single())).value
  expect(stored).toEqual({ name: 'VadMassage', email: 'hello@vadmassage.example', address: '1 Example Street\nLondon', closing: 'Thank you.', ...CREDENTIALS })
  await page.reload()
  await expect(page.getByLabel('Business name')).toHaveValue('VadMassage')
  await expect(page.getByLabel('Email')).toHaveValue('hello@vadmassage.example')
  await expect(page.getByText('Nothing is saved here yet.')).toHaveCount(0)
})

test('only a booking whose payment has been received shows Receipt, and without her details it asks for them first', async ({ page }) => {
  await f.authorize()
  const [paid, cancelled, waiting] = f.bookings
  await markPaid(paid.id)
  await signIn(page, `/admin/bookings/${waiting.id}`)
  await expect(page.locator('dialog.admin-details')).toBeVisible()
  await expect(receiptButton(page)).toHaveCount(0)
  await page.goto(`/admin/bookings/${cancelled.id}`)
  await expect(page.locator('dialog.admin-details')).toBeVisible()
  await expect(receiptButton(page)).toHaveCount(0)
  await page.goto(`/admin/bookings/${paid.id}`)
  await receiptButton(page).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Save your business details first: More, Receipt details.' })).toBeVisible()
  expect((await f.admin.from('booking_receipts').select('id').eq('booking_id', paid.id)).data).toEqual([])
  await page.getByRole('button', { name: 'Open Receipt details' }).click()
  await expect(page).toHaveURL(/\/admin\/settings\/receipts$/)
  await expect(page.getByRole('heading', { name: 'Receipt details', level: 1 })).toBeVisible()
  // The booking closes behind her, so focus goes to the new page's heading and is not lost.
  await expect(page.getByRole('heading', { name: 'Receipt details', level: 1 })).toBeFocused()
})

test('opening a receipt shows what was paid, with the same number every time and no address', async ({ page }) => {
  await f.authorize()
  await saveDetails()
  const paid = f.bookings[0]
  await markPaid(paid.id)
  await signIn(page, `/admin/bookings/${paid.id}`)
  await receiptButton(page).click()
  await expect(card(page)).toBeVisible()
  await expect(card(page)).toHaveAccessibleName(`Receipt VAD-${year}-0001`)
  // Focus moves to the receipt, so a keyboard or screen reader is not left where the button used to be.
  await expect(card(page)).toBeFocused()
  await expect(card(page)).toContainText('VadMassage')
  await expect(card(page)).toContainText('07700 900123 · hello@vadmassage.example')
  await expect(card(page)).toContainText('1 Example Street')
  await expect(card(page)).toContainText('Received from')
  await expect(card(page)).toContainText('Total paid')
  await expect(card(page)).toContainText('£85.00')
  await expect(card(page)).toContainText('Paid by cash on')
  await expect(card(page)).toContainText('Thank you.')
  await expect(card(page)).toContainText('Vadim Susarin, Level 5 Soft Tissue Therapist, Institute for Soft Tissue Therapists (ISRM), membership number 9555')
  await expect(card(page)).not.toContainText('SW1A')
  await expect(card(page)).not.toContainText('VeryLongStreet')
  // A very long first name does not push the buttons off the screen.
  await expect(page.getByRole('button', { name: /^Email to Alexandra/ })).toBeVisible()
  // The PDF for the client or their insurer.
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download PDF' }).click()
  const pdf = await download
  expect(pdf.suggestedFilename()).toBe(`Receipt VAD-${year}-0001.pdf`)
  expect((await import('node:fs')).readFileSync(await pdf.path()).subarray(0, 5).toString()).toBe('%PDF-')
  await page.getByRole('button', { name: 'Close details' }).click()
  await page.goto(`/admin/bookings/${paid.id}`)
  await receiptButton(page).click()
  await expect(card(page)).toHaveAccessibleName(`Receipt VAD-${year}-0001`)
  expect((await f.admin.from('booking_receipts').select('id').eq('booking_id', paid.id)).data).toHaveLength(1)
})

test('Edit changes the words on the receipt but never the amounts, and keeps what it said before', async ({ page }) => {
  await f.authorize()
  await saveDetails()
  const paid = f.bookings[0]
  await markPaid(paid.id)
  await signIn(page, `/admin/bookings/${paid.id}`)
  await receiptButton(page).click()
  await page.getByRole('button', { name: /^Edit receipt/ }).click()
  const form = page.getByRole('form', { name: /^Edit receipt/ })
  await expect(form.getByLabel('Received from')).toBeFocused()
  await expect(form).toContainText('The amounts, the receipt number, and how and when it was paid come from the booking, so they cannot be changed here.')
  // The amounts are shown beside each line, not offered as fields.
  await expect(form.getByLabel(/^Line 1, £85\.00/)).toBeVisible()
  await expect(form.locator('input[value="85"], input[value="85.00"]')).toHaveCount(0)
  await form.getByLabel('Received from').fill('')
  await expect(form.getByText('Enter who the receipt is for.')).toBeVisible()
  await expect(form.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  await form.getByLabel('Received from').fill('Jensen Holdings Ltd')
  await form.getByLabel('Note on the receipt (optional)').fill('Order 4471')
  await form.getByLabel(/^Line 1, £85\.00/).fill('Sports massage, 60 minutes')
  await form.getByLabel('Business name').fill('VadMassage Ltd')
  await form.getByRole('button', { name: 'Cancel' }).click()
  await expect(card(page)).toBeFocused()
  await expect(card(page)).toContainText('VadMassage')
  await expect(card(page)).not.toContainText('Order 4471')
  await page.getByRole('button', { name: /^Edit receipt/ }).click()
  await page.getByRole('form', { name: /^Edit receipt/ }).getByLabel('Received from').fill('Jensen Holdings Ltd')
  await page.getByRole('form', { name: /^Edit receipt/ }).getByLabel('Note on the receipt (optional)').fill('Order 4471')
  await page.getByRole('form', { name: /^Edit receipt/ }).getByLabel(/^Line 1, £85\.00/).fill('Sports massage, 60 minutes')
  await page.getByRole('form', { name: /^Edit receipt/ }).getByLabel('Business name').fill('VadMassage Ltd')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible()
  await expect(card(page)).toContainText('Jensen Holdings Ltd')
  await expect(card(page)).toContainText('Sports massage, 60 minutes')
  await expect(card(page)).toContainText('£85.00')
  await expect(card(page)).toContainText('Order 4471')
  await expect(card(page)).toContainText('VadMassage Ltd')
  await expect(card(page)).toHaveAccessibleName(`Receipt VAD-${year}-0001`)
  const receipt = await unwrap(f.admin.from('booking_receipts').select('id,edit_count,snapshot').eq('booking_id', paid.id).single())
  expect(receipt.edit_count).toBe(1)
  expect(receipt.snapshot.total).toBe(85)
  const revisions = await unwrap(f.admin.from('booking_receipt_revisions').select('snapshot').eq('receipt_id', receipt.id))
  expect(revisions.map(row => row.snapshot.billed_to)).toEqual([expect.stringContaining('Alexandra')])
})

// The sender is not running in these tests, so what it would do is done by hand on the queued email.
const deliveryOf = async id => (await unwrap(f.admin.from('event_outbox').select('notification_deliveries(id)').eq('aggregate_id', id).eq('event_type', 'booking.receipt_emailed').order('created_at', { ascending: false }).limit(1))).flatMap(row => row.notification_deliveries)[0]
const setDelivery = async (id, patch) => unwrap(f.admin.from('notification_deliveries').update(patch).eq('id', (await deliveryOf(id)).id))

test('emailing queues one email for the booking\'s address, says only what is true about it, and notices a change made afterwards', async ({ page }) => {
  await f.authorize()
  await saveDetails()
  const paid = f.bookings[0]
  await markPaid(paid.id)
  await signIn(page, `/admin/bookings/${paid.id}`)
  await receiptButton(page).click()
  const send = page.getByRole('button', { name: /^Email to / })
  await send.dblclick()
  // Queued is not sent: the screen says it is waiting until the sender has delivered it.
  await expect(page.getByText('Email queued for booking@example.test. It usually goes within a few minutes.')).toBeVisible()
  await expect(page.getByText(/^Emailed to /)).toHaveCount(0)
  expect(await queued(paid.id)).toHaveLength(1)
  expect((await queued(paid.id))[0]).toMatchObject({ recipient: 'booking@example.test', title: `Your receipt from VadMassage (VAD-${year}-0001)` })
  expect((await queued(paid.id))[0].body).toContain('Total paid: £85.00')
  await setDelivery(paid.id, { status: 'sent', sent_at: new Date().toISOString() })
  await page.getByRole('button', { name: 'Check if it was sent' }).click()
  await expect(page.getByText(/^Emailed to booking@example\.test on /)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Check if it was sent' })).toHaveCount(0)
  // The button that was pressed is gone, so focus moves to the line that now says it was sent, and is not lost.
  await expect(page.getByText(/^Emailed to booking@example\.test on /)).toBeFocused()
  await page.getByRole('button', { name: /^Edit receipt/ }).click()
  await page.getByRole('form', { name: /^Edit receipt/ }).getByLabel('Note on the receipt (optional)').fill('Added after sending')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('You changed this receipt after you emailed it, so the email has the old words.')).toBeVisible()
  await send.click()
  await expect(page.getByText('Email queued for booking@example.test. It usually goes within a few minutes.')).toBeVisible()
  await expect(page.getByText('You changed this receipt after you emailed it')).toHaveCount(0)
  expect(await queued(paid.id)).toHaveLength(2)
})

test('an email that did not go through is said to have failed, not to have been sent', async ({ page }) => {
  await f.authorize()
  await saveDetails()
  const paid = f.bookings[0]
  await markPaid(paid.id)
  await signIn(page, `/admin/bookings/${paid.id}`)
  await receiptButton(page).click()
  await page.getByRole('button', { name: /^Email to / }).click()
  await expect(page.getByText('Email queued for booking@example.test.')).toBeVisible()
  await setDelivery(paid.id, { status: 'failed', attempt_count: 2, last_error: 'The mail service refused it' })
  await page.getByRole('button', { name: 'Check if it was sent' }).click()
  await expect(page.getByText('The email to booking@example.test has not gone through yet. It will try again by itself.')).toBeVisible()
  await expect(page.getByText(/^Emailed to /)).toHaveCount(0)
  await setDelivery(paid.id, { status: 'failed', attempt_count: 5 })
  await page.getByRole('button', { name: 'Check if it was sent' }).click()
  await expect(page.getByText('The email to booking@example.test could not be sent. Press Email to try again, or send the receipt by WhatsApp or Share.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Check if it was sent' })).toHaveCount(0)
  // The error never shows the reason the mail service gave.
  await expect(page.getByText('The mail service refused it')).toHaveCount(0)
})

test('pressing Email again after the connection dropped never sends it twice', async ({ page }) => {
  await f.authorize()
  await saveDetails()
  const paid = f.bookings[0]
  await markPaid(paid.id)
  await signIn(page, `/admin/bookings/${paid.id}`)
  await receiptButton(page).click()
  // The first press reaches the database but the answer never comes back.
  let dropped = false
  await page.route('**/rest/v1/rpc/admin_email_receipt', async route => {
    if (dropped) return route.continue()
    dropped = true
    await route.fetch()
    return route.abort('connectionreset')
  })
  await page.getByRole('button', { name: /^Email to / }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Could not complete that.' })).toBeVisible()
  expect(await queued(paid.id)).toHaveLength(1)
  await page.getByRole('button', { name: /^Email to / }).click()
  await expect(page.getByText('Email queued for booking@example.test. It usually goes within a few minutes.')).toBeVisible()
  expect(await queued(paid.id)).toHaveLength(1)
  // Once the answer has arrived, the next press is a deliberate second email.
  await page.getByRole('button', { name: /^Email to / }).click()
  await expect.poll(async () => (await queued(paid.id)).length).toBe(2)
})

test('a booking moved after its receipt was made says so, and one tap brings the receipt up to date', async ({ page }) => {
  await f.authorize()
  await saveDetails()
  const paid = f.bookings[0]
  await markPaid(paid.id)
  await signIn(page, `/admin/bookings/${paid.id}`)
  await receiptButton(page).click()
  await expect(card(page)).toContainText('10:00')
  await expect(page.getByText('This booking was moved after the receipt was made')).toHaveCount(0)
  await unwrap(f.admin.from('bookings').update({ start_minutes: 660 }).eq('id', paid.id))
  await page.getByRole('button', { name: 'Check for changes' }).click()
  await expect(page.getByText('This booking was moved after the receipt was made, so the date and time on the receipt are out of date.')).toBeVisible()
  await expect(card(page)).toContainText('10:00')
  await page.getByRole('button', { name: 'Update the date and time' }).click()
  await expect(card(page)).toContainText('11:00')
  await expect(card(page)).toBeFocused()
  await expect(page.getByText('This booking was moved after the receipt was made')).toHaveCount(0)
  await expect(page.getByText('The date and time on the receipt are up to date.')).toBeVisible()
  const receipt = await unwrap(f.admin.from('booking_receipts').select('id,edit_count').eq('booking_id', paid.id).single())
  expect(receipt.edit_count).toBe(1)
})

test('a receipt made before the booking was cancelled is shown as a note and can no longer be sent', async ({ page }) => {
  await f.authorize()
  await saveDetails()
  const paid = f.bookings[0]
  await markPaid(paid.id)
  await signIn(page, `/admin/bookings/${paid.id}`)
  await receiptButton(page).click()
  await page.getByRole('button', { name: /^Email to / }).click()
  await expect(page.getByText('Email queued for booking@example.test.')).toBeVisible()
  await setDelivery(paid.id, { status: 'sent', sent_at: new Date().toISOString() })
  await unwrap(f.admin.from('bookings').update({ booking_status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by_actor_type: 'admin' }).eq('id', paid.id))
  await page.goto(`/admin/bookings/${paid.id}`)
  await expect(page.locator('dialog.admin-details')).toBeVisible()
  await expect(page.getByText(`Receipt VAD-${year}-0001 was made for this booking, and emailed to booking@example.test on`)).toBeVisible()
  await expect(page.getByText('Because the booking was cancelled, it can no longer be sent or changed.')).toBeVisible()
  await expect(receiptButton(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Email to / })).toHaveCount(0)
})

test('a Save that did not go through keeps what was typed and the focus, and says so', async ({ page }) => {
  await f.authorize()
  await saveDetails()
  const paid = f.bookings[0]
  await markPaid(paid.id)
  await signIn(page, `/admin/bookings/${paid.id}`)
  await receiptButton(page).click()
  await page.getByRole('button', { name: /^Edit receipt/ }).click()
  const form = page.getByRole('form', { name: /^Edit receipt/ })
  await form.getByLabel('Note on the receipt (optional)').fill('Order 4471')
  await page.route('**/rest/v1/rpc/admin_edit_receipt', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'connection to the database failed' }) }))
  await form.getByRole('button', { name: 'Save changes' }).click()
  await expect(form.getByRole('alert').filter({ hasText: 'Could not complete that.' })).toBeVisible()
  // Nothing technical is shown, the words typed are still there, and the keyboard is still on the button.
  await expect(page.getByText('connection to the database failed')).toHaveCount(0)
  await expect(form.getByLabel('Note on the receipt (optional)')).toHaveValue('Order 4471')
  await expect(form.getByRole('button', { name: 'Save changes' })).toBeFocused()
  await page.unroute('**/rest/v1/rpc/admin_edit_receipt')
  await form.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible()
  await expect(card(page)).toContainText('Order 4471')
})

test('after looking at what became of an email, pressing Email again sends a new one', async ({ page }) => {
  await f.authorize()
  await saveDetails()
  const paid = f.bookings[0]
  await markPaid(paid.id)
  await signIn(page, `/admin/bookings/${paid.id}`)
  await receiptButton(page).click()
  // The first press reaches the database but the answer never comes back.
  let dropped = false
  await page.route('**/rest/v1/rpc/admin_email_receipt', async route => {
    if (dropped) return route.continue()
    dropped = true
    await route.fetch()
    return route.abort('connectionreset')
  })
  await page.getByRole('button', { name: /^Email to / }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Could not complete that.' })).toBeVisible()
  expect(await queued(paid.id)).toHaveLength(1)
  // She looks: the booking is read again, and the receipt shows the email that is waiting.
  await page.getByRole('button', { name: 'Check for changes' }).click()
  await expect(page.getByText('Email queued for booking@example.test.')).toBeVisible()
  await setDelivery(paid.id, { status: 'failed', attempt_count: 5 })
  await page.getByRole('button', { name: 'Check if it was sent' }).click()
  await expect(page.getByText(/could not be sent\. Press Email to try again/)).toBeVisible()
  // Now Email is a deliberate new send, not the lost first one again.
  await page.getByRole('button', { name: /^Email to / }).click()
  await expect.poll(async () => (await queued(paid.id)).length).toBe(2)
  await expect(page.getByText('Email queued for booking@example.test.')).toBeVisible()
  // The button that was pressed keeps the keyboard.
  await expect(page.getByRole('button', { name: /^Email to / })).toBeFocused()
})

test('an email that has waited too long, or whose record is gone, is not said to have been sent', async ({ page }) => {
  await f.authorize()
  await saveDetails()
  const paid = f.bookings[0]
  await markPaid(paid.id)
  await signIn(page, `/admin/bookings/${paid.id}`)
  await receiptButton(page).click()
  await page.getByRole('button', { name: /^Email to / }).click()
  await expect(page.getByText('Email queued for booking@example.test.')).toBeVisible()
  // Queued twenty minutes ago and still waiting: the sender may not be running, so no promise of a quick send.
  await setDelivery(paid.id, { created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString() })
  await page.getByRole('button', { name: 'Check if it was sent' }).click()
  await expect(page.getByText('The email to booking@example.test is still waiting to be sent. Check again in a few minutes, or send the receipt by WhatsApp or Share instead.')).toBeVisible()
  await expect(page.getByText('It usually goes within a few minutes.')).toHaveCount(0)
  // Its delivery record is gone: all that is left is that an email was queued once.
  await unwrap(f.admin.from('event_outbox').delete().eq('aggregate_id', paid.id).eq('event_type', 'booking.receipt_emailed'))
  await page.getByRole('button', { name: 'Check for changes' }).click()
  await expect(page.getByText(/^An email to booking@example\.test was queued on .+\. There is no record of whether it was delivered\.$/)).toBeVisible()
  await expect(page.getByText(/^Emailed to /)).toHaveCount(0)
})

test('a booking whose price is no longer the amount on the receipt says so', async ({ page }) => {
  await f.authorize()
  await saveDetails()
  const paid = f.bookings[0]
  await markPaid(paid.id)
  await signIn(page, `/admin/bookings/${paid.id}`)
  await receiptButton(page).click()
  await expect(page.getByText(/is no longer the £85\.00 on this receipt/)).toHaveCount(0)
  await unwrap(f.admin.from('bookings').update({ total_gbp: 95 }).eq('id', paid.id))
  await page.getByRole('button', { name: 'Check for changes' }).click()
  await expect(page.getByText('The price on this booking is no longer the £85.00 on this receipt. Check the booking before you send it.')).toBeVisible()
  await expect(card(page)).toContainText('£85.00')
})

for (const [name, change, reason] of [
  ['payment was refunded', id => unwrap(f.admin.from('booking_payments').update({ status: 'refunded', paid_at: null }).eq('booking_id', id)), 'Because the payment was refunded, it can no longer be sent or changed.'],
  ['appointment was marked as missed', id => unwrap(f.admin.from('bookings').update({ booking_status: 'no_show' }).eq('id', id)), 'Because the appointment was marked as missed, it can no longer be sent or changed.'],
]) {
  test(`a receipt made before the ${name} is shown as a note and can no longer be sent`, async ({ page }) => {
    await f.authorize()
    await saveDetails()
    const paid = f.bookings[0]
    await markPaid(paid.id)
    await signIn(page, `/admin/bookings/${paid.id}`)
    await receiptButton(page).click()
    await expect(card(page)).toBeVisible()
    await change(paid.id)
    await page.goto(`/admin/bookings/${paid.id}`)
    await expect(page.locator('dialog.admin-details')).toBeVisible()
    await expect(page.getByText(`Receipt VAD-${year}-0001 was made for this booking.`)).toBeVisible()
    await expect(page.getByText(reason)).toBeVisible()
    await expect(receiptButton(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Email to / })).toHaveCount(0)
  })
}

test('the receipt can be sent on WhatsApp with the words already typed, or shared or copied', async ({ page }) => {
  await f.authorize()
  await saveDetails()
  const paid = f.bookings[0]
  await markPaid(paid.id)
  // A phone shares through its own sheet; a computer without one copies the text instead.
  await page.addInitScript(() => { window.__shared = null; Object.defineProperty(navigator, 'share', { configurable: true, value: async data => { window.__shared = data } }) })
  await signIn(page, `/admin/bookings/${paid.id}`)
  await receiptButton(page).click()
  const link = await page.getByRole('link', { name: /^WhatsApp / }).getAttribute('href')
  expect(link.startsWith('https://wa.me/447700900002?text=')).toBe(true)
  const text = decodeURIComponent(link.split('?text=')[1])
  expect(text).toContain(`Receipt VAD-${year}-0001`)
  expect(text).toContain('Total paid: £85.00')
  await page.getByRole('button', { name: 'Share or copy' }).click()
  const shared = await page.evaluate(() => window.__shared)
  expect(shared.title).toBe(`Receipt VAD-${year}-0001`)
  expect(shared.text).toBe(text)
  await page.evaluate(() => { Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }) })
  await page.getByRole('button', { name: 'Share or copy' }).click()
  await expect(page.getByText('Copied. Paste it into a message to send it.')).toBeVisible()
  // Windows keeps line breaks as two characters on the clipboard; the words are the same.
  expect((await page.evaluate(() => navigator.clipboard.readText())).split('\r\n').join('\n')).toBe(text)
})

for (const width of [320, 360, 430]) {
  test(`the receipt, its buttons and the edit form fit a ${width}px phone`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await f.authorize()
    await saveDetails({ ...DETAILS, address: '1 Example Street With A Rather Long Name, London, SW1A 1AA' })
    const paid = f.bookings[0]
    await markPaid(paid.id)
    await signIn(page, `/admin/bookings/${paid.id}`)
    await receiptButton(page).click()
    await expect(card(page)).toBeVisible()
    const fits = () => page.evaluate(limit => {
      const dialog = document.querySelector('dialog.admin-details')
      const inside = [...dialog.querySelectorAll('.admin-receipt-panel button, .admin-receipt-panel a, .admin-receipt-panel input, .admin-receipt-panel textarea, .admin-receipt')].every(item => { const r = item.getBoundingClientRect(); return r.left >= -0.5 && r.right <= limit + 0.5 })
      return inside && dialog.scrollWidth <= dialog.clientWidth
    }, width)
    expect(await fits()).toBe(true)
    await page.getByRole('button', { name: /^Edit receipt/ }).click()
    await expect(page.getByRole('form', { name: /^Edit receipt/ })).toBeVisible()
    expect(await fits()).toBe(true)
  })
}
