import { test, expect } from '@playwright/test'
import { localFixture } from '../localSupabase.js'

test.use({ hasTouch: true })
let fixture
test.beforeEach(async () => { fixture = await localFixture(25) })
test.afterEach(async () => { await fixture?.cleanup() })

for (const mode of ['native', 'unavailable', 'restricted']) {
  test(`date field click and tap preserve native entry when picker is ${mode}`, async ({ page }) => {
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/')
    await page.getByRole('button', { name: /Integration area/ }).click()
    await page.getByRole('button', { name: /Integration massage/ }).click()
    await page.getByRole('button', { name: 'Add 60 minutes', exact: true }).click()
    await page.getByRole('button', { name: 'Choose date & time' }).click()
    const field = page.getByLabel('Appointment date')
    await field.fill(fixture.date)
    await field.evaluate((input, mode) => {
      const native = input.showPicker
      input.dataset.pickerCalls = '0'
      input.dataset.pickerSuccesses = '0'
      input.showPicker = mode === 'unavailable' ? undefined : function () {
        this.dataset.pickerCalls = String(Number(this.dataset.pickerCalls) + 1)
        if (mode === 'restricted') throw new DOMException('Picker restricted', 'NotAllowedError')
        native.call(this)
        this.dataset.pickerSuccesses = String(Number(this.dataset.pickerSuccesses) + 1)
      }
    }, mode)
    await expect(field).toHaveCSS('cursor', 'pointer')
    // Left side and centre are deliberately away from the calendar icon.
    await field.click({ position: { x: 12, y: 20 } })
    await page.keyboard.press('Escape')
    const bounds = await field.boundingBox()
    await field.tap({ position: { x: bounds.width / 2, y: 20 } })
    await page.keyboard.press('Escape')
    await expect(field).toHaveAttribute('data-picker-calls', mode === 'unavailable' ? '0' : '2')
    if (mode === 'native') await expect(field).toHaveAttribute('data-picker-successes', '2')
    await expect(field).toHaveValue(fixture.date)
    // The existing onChange contract still requests real availability.
    await field.fill('')
    await field.fill(fixture.date)
    await expect(page.getByRole('button', { name: '10:00', exact: true })).toBeVisible()
    expect(errors).toEqual([])
  })
}
