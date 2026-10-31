import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'
import { dateLabel } from '../../src/admin/calendarPresentation.js'

// The fixture's own day (today plus 5) is open 10:00 to 22:00 and has a confirmed booking at 10:00 for an hour, with an hour's travel either side.
let f
test.beforeEach(async () => { f = await adminFixture(5) })
test.afterEach(async () => {
  await f.admin.from('calendar_blocks').delete().eq('date', f.date)
  await f?.cleanup()
})

async function openGrid(page) {
  await f.authorize()
  await page.goto(`/admin?date=${f.date}`)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Edit hours', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/day-hours\\?date=${f.date}$`))
  await expect(page.getByRole('heading', { name: 'Edit hours', level: 1 })).toBeFocused()
}
const cell = (page, time) => page.getByRole('button', { name: new RegExp(`^${time} to `) })
const blocks = async () => (await f.admin.from('calendar_blocks').select('start_minutes,end_minutes,kind,title').eq('date', f.date).order('start_minutes')).data
const override = async () => (await f.admin.from('working_hours_overrides').select('available,start_minutes,end_minutes').eq('date', f.date).single()).data

test('the day opens from the Day view as half hours: working ones pressed, the booking and its travel locked', async ({ page }) => {
  await openGrid(page)
  await expect(page.getByText('10:00–22:00', { exact: true })).toBeVisible()
  await expect(cell(page, '12:00')).toHaveAttribute('aria-pressed', 'true')
  await expect(cell(page, '22:00')).toHaveAttribute('aria-pressed', 'false')
  await expect(cell(page, '10:00')).toHaveAccessibleName(/booking/)
  // The booking says its times, so its last half hour is not mistaken for the travel after it.
  await expect(cell(page, '10:00')).toContainText('· 10:00–11:00')
  await expect(cell(page, '11:00')).toHaveAccessibleName(/travel time/)
  // Nothing has been tapped, so there is nothing to save.
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  // A booking cannot be tapped closed; the screen says why.
  await cell(page, '10:00').click()
  await expect(page.getByText('This half hour has a booking. Move or cancel the booking first.')).toBeVisible()
  await expect(cell(page, '10:00')).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('tapping two half hours closed saves them as blocked time and goes back to the day', async ({ page }) => {
  await openGrid(page)
  await cell(page, '13:00').click()
  await cell(page, '13:30').click()
  await expect(cell(page, '13:00')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByText('10:00–13:00, 14:00–22:00', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Save 2 changes', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/admin\\?date=${f.date}$`))
  await expect(page.getByText(`Saved · ${dateLabel(f.date)}`).last()).toBeVisible()
  expect(await blocks()).toEqual([{ start_minutes: 780, end_minutes: 840, kind: 'blocked', title: null }])
  expect(await override()).toEqual({ available: true, start_minutes: 600, end_minutes: 1320 })
})

test('sliding down several half hours closes them together, and the end of the day moves the hours', async ({ page }) => {
  await openGrid(page)
  await cell(page, '20:00').evaluate(element => element.scrollIntoView({ block: 'center' }))
  const first = await cell(page, '20:00').boundingBox()
  const last = await cell(page, '21:30').boundingBox()
  await page.mouse.move(first.x + 40, first.y + first.height / 2)
  await page.mouse.down()
  await page.mouse.move(last.x + 40, last.y + last.height / 2, { steps: 8 })
  await page.mouse.up()
  for (const time of ['20:00', '20:30', '21:00', '21:30']) await expect(cell(page, time)).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: 'Save 4 changes', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/admin\\?date=${f.date}$`))
  expect(await override()).toEqual({ available: true, start_minutes: 600, end_minutes: 1200 })
  expect(await blocks()).toEqual([])
})

test('a tap can be undone by tapping again, and Cancel asks before throwing changes away', async ({ page }) => {
  await openGrid(page)
  await cell(page, '15:00').click()
  await cell(page, '15:00').click()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await cell(page, '15:00').click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByText('Discard your change? This day stays as it was.')).toBeVisible()
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(cell(page, '15:00')).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/admin\\?date=${f.date}$`))
  expect(await blocks()).toEqual([])
})

test('Day off closes everything but the booking and its travel', async ({ page }) => {
  await openGrid(page)
  await page.getByRole('switch', { name: 'Day off' }).click()
  await expect(page.getByRole('switch', { name: 'Day off' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText('Your bookings stay as they are.')).toBeVisible()
  await expect(page.getByText('10:00–12:00', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^Save \d+ changes$/ }).click()
  await expect(page).toHaveURL(new RegExp(`/admin\\?date=${f.date}$`))
  expect(await override()).toEqual({ available: true, start_minutes: 600, end_minutes: 720 })
})

test('closing time a client is in the middle of booking is asked about first', async ({ page }) => {
  const client = (await f.admin.from('clients').select('id').limit(1).single()).data
  await f.admin.from('booking_holds').insert({ client_id: client.id, date: f.date, start_minutes: 960, treatment_duration_minutes: 60, travel_buffer_minutes: 60,
    expires_at: new Date(Date.now() + 10 * 60000).toISOString() })
  try {
    await openGrid(page)
    await expect(cell(page, '16:00')).toHaveAccessibleName(/a client is booking this time/)
    await cell(page, '16:00').click()
    await page.getByRole('button', { name: 'Save 1 change', exact: true }).click()
    await expect(page.getByText('A client is booking 16:00–16:30 right now.')).toBeVisible()
    expect(await blocks()).toEqual([])
    await page.getByRole('button', { name: 'Close it anyway', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/admin\\?date=${f.date}$`))
    expect(await blocks()).toEqual([{ start_minutes: 960, end_minutes: 990, kind: 'blocked', title: null }])
  } finally {
    await f.admin.from('booking_holds').delete().eq('date', f.date).eq('start_minutes', 960)
  }
})

test.describe('on a phone', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 412, height: 780 } })
  // Fingers are sent through the DevTools protocol, which is what Android Chrome sees: touches with a scroll the browser may take.
  async function finger(page) {
    const cdp = await page.context().newCDPSession(page)
    const send = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
    return {
      async swipe(x, fromY, toY) {
        await send('touchStart', x, fromY)
        for (let step = 1; step <= 10; step += 1) await send('touchMove', x, fromY + (toY - fromY) * step / 10)
        await send('touchEnd')
      },
      async tap(x, y) { await send('touchStart', x, y); await send('touchEnd') },
      async holdAndSlide(x, fromY, toY) {
        await send('touchStart', x, fromY)
        await page.waitForTimeout(500)
        for (let step = 1; step <= 10; step += 1) await send('touchMove', x, fromY + (toY - fromY) * step / 10)
        await send('touchEnd')
      },
    }
  }
  const middle = async locator => { const box = await locator.boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 } }

  test('a swipe on the blocks scrolls the whole day and changes nothing', async ({ page }) => {
    await openGrid(page)
    const touch = await finger(page)
    const start = await middle(cell(page, '12:00'))
    for (let swipe = 0; swipe < 6; swipe += 1) await touch.swipe(start.x, 600, 150)
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(400)
    // The last half hour of the day can be reached above the Save bar.
    await expect(cell(page, '22:00')).toBeInViewport()
    const save = await page.getByRole('button', { name: 'Save', exact: true }).boundingBox()
    expect((await cell(page, '22:00').boundingBox()).y + 44).toBeLessThanOrEqual(save.y)
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  })

  test('a tap changes one block, and a hold then a slide changes several', async ({ page }) => {
    await openGrid(page)
    const touch = await finger(page)
    await cell(page, '14:00').evaluate(element => element.scrollIntoView({ block: 'center' }))
    const one = await middle(cell(page, '14:00'))
    await touch.tap(one.x, one.y)
    await expect(cell(page, '14:00')).toHaveAttribute('aria-pressed', 'false')
    const first = await middle(cell(page, '15:00'))
    const last = await middle(cell(page, '16:00'))
    await touch.holdAndSlide(first.x, first.y, last.y)
    for (const time of ['15:00', '15:30', '16:00']) await expect(cell(page, time)).toHaveAttribute('aria-pressed', 'false')
    await expect(cell(page, '16:30')).toHaveAttribute('aria-pressed', 'true')
    // The page stayed put under the finger (the hours line above may wrap, so the page itself is not compared).
    expect(Math.abs((await middle(cell(page, '15:00'))).y - first.y)).toBeLessThan(2)
    await expect(page.getByRole('button', { name: 'Save 4 changes', exact: true })).toBeEnabled()
  })
})
