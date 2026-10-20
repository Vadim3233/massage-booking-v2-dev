import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'

// The share button on the booking sheet: WhatsApp straight to the client's chat with the details, or Share… (copy where there is no share sheet).
// The fixture's day has a confirmed booking at 10:00 with its cash approved, for a client with phone +447700900002, and a cancelled one at 13:00.
let f
test.beforeEach(async () => { f = await adminFixture(5) })
test.afterEach(async () => { await f?.cleanup() })

async function openBooking(page, id) {
  await page.goto(`/admin/bookings/${id}`)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('dialog.admin-details')).toBeVisible()
}
const sheet = page => page.locator('dialog.admin-details')
const shareButton = page => sheet(page).getByRole('button', { name: 'Share booking details' })

test('WhatsApp client opens the client\'s own chat with the booking details, and nothing private', async ({ page }) => {
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  await openBooking(page, f.bookings[0].id)
  await shareButton(page).click()
  await expect(shareButton(page)).toHaveAttribute('aria-expanded', 'true')
  const link = sheet(page).getByRole('link', { name: 'WhatsApp client' })
  const href = await link.getAttribute('href')
  expect(href).toMatch(/^https:\/\/wa\.me\/447700900002\?text=/)
  const text = decodeURIComponent(href.split('?text=')[1])
  expect(text).toMatch(/^\*Massage booking – .+, 10:00–11:00\*\n/)
  expect(text).toContain('Payment: cash, due at the appointment')
  // Until when the client can cancel or move for free, from the database's rule (the booking is days away, so the free period is still open).
  expect(text).toMatch(/\nFree to cancel or move until \w{3} \d{1,2} \w{3}, \d{2}:\d{2}\. After that, the full price may be charged\.$/m)
  for (const secret of ['canonical@example.test', 'booking@example.test', '07700', '+44', 'Exact persisted note', f.bookings[0].id]) expect(text).not.toContain(secret)
  await page.screenshot({ path: 'test-results/share-booking-menu.png' })
})

test('Share… uses the phone\'s share sheet, and copies the same text where there is none', async ({ page }) => {
  await f.authorize()
  // A share sheet that only remembers what it was given.
  await page.addInitScript(() => { navigator.share = async data => { window.sharedText = data.text } })
  await openBooking(page, f.bookings[0].id)
  await shareButton(page).click()
  const whatsappText = decodeURIComponent((await sheet(page).getByRole('link', { name: 'WhatsApp client' }).getAttribute('href')).split('?text=')[1])
  await sheet(page).getByRole('button', { name: 'Share…' }).click()
  await expect.poll(() => page.evaluate(() => window.sharedText)).toBe(whatsappText)
  // No share sheet (a computer): the text is copied and the screen says so.
  await page.addInitScript(() => {
    delete Navigator.prototype.share
    navigator.share = undefined
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copiedText = text } } })
  })
  await page.reload()
  await expect(sheet(page)).toBeVisible()
  await shareButton(page).click()
  await sheet(page).getByRole('button', { name: 'Share…' }).click()
  await expect(sheet(page).getByText('Copied', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.copiedText)).toBe(whatsappText)
})

test('Copy puts the same text on the clipboard and says Copied', async ({ page }) => {
  await f.authorize()
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copiedText = text } } }) })
  await openBooking(page, f.bookings[0].id)
  await shareButton(page).click()
  const whatsappText = decodeURIComponent((await sheet(page).getByRole('link', { name: 'WhatsApp client' }).getAttribute('href')).split('?text=')[1])
  await sheet(page).getByRole('button', { name: 'Copy', exact: true }).click()
  await expect(sheet(page).getByText('Copied', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.copiedText)).toBe(whatsappText)
})

test('a cancelled booking has no share button', async ({ page }) => {
  await f.authorize()
  await openBooking(page, f.bookings[1].id)
  await expect(sheet(page).getByText('Cancelled').first()).toBeVisible()
  await expect(shareButton(page)).toHaveCount(0)
})

test('Settings › Share message: blanks, an example, Reset, and the share button then uses the saved wording', async ({ page }) => {
  await f.authorize()
  await page.setViewportSize({ width: 390, height: 844 })
  try {
    await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copiedText = text } } }) })
    await page.goto('/admin/settings/share-message')
    await page.getByLabel('Email', { exact: true }).fill(f.email)
    await page.getByLabel('Password', { exact: true }).fill(f.password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    const box = page.getByRole('textbox', { name: 'Message', exact: true })
    await expect(box).toHaveValue(/^\*Massage booking – \{date\}, \{time\}\*/)
    await expect(page.getByRole('button', { name: 'Reset to standard' })).toBeDisabled()
    // A blank that is not on the list cannot be saved.
    await box.fill('Your number {phone}')
    await expect(page.getByRole('alert')).toHaveText('Only the blanks listed can be used, each in curly brackets.')
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await box.fill('Hi! See you ')
    await page.getByRole('group', { name: 'Add a blank' }).getByRole('button', { name: '{date}' }).click()
    await box.press('End')
    await box.pressSequentially(' at ')
    await page.getByRole('group', { name: 'Add a blank' }).getByRole('button', { name: '{time}' }).click()
    await expect(box).toHaveValue('Hi! See you {date} at {time}')
    await expect(page.locator('.admin-share-preview')).toHaveText('Hi! See you Thu 12 Nov at 17:30–19:00')
    await page.screenshot({ path: 'test-results/share-message-settings.png', fullPage: true })
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved. The share button uses it now.')).toBeVisible()
    // The share button now sends that wording.
    await page.goto(`/admin/bookings/${f.bookings[0].id}`)
    await shareButton(page).click()
    await sheet(page).getByRole('button', { name: 'Copy', exact: true }).click()
    await expect(sheet(page).getByText('Copied', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.copiedText)).toMatch(/^Hi! See you .+ at 10:00–11:00$/)
    // Reset to standard, saved, gives the standard message again.
    await page.goto('/admin/settings/share-message')
    await page.getByRole('button', { name: 'Reset to standard' }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved. The share button uses it now.')).toBeVisible()
    expect((await f.admin.from('business_settings').select('key').eq('key', 'share_message')).data).toEqual([])
  } finally {
    await f.admin.from('business_settings').delete().eq('key', 'share_message')
  }
})
