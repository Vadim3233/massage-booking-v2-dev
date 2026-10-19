import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { adminFixture } from '../adminFixture.js'
import { shiftDate } from '../../src/admin/calendarPresentation.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'

let f
const made = { clients: [], users: [] }
test.beforeEach(async () => { f = await adminFixture(39); made.clients = []; made.users = [] })
test.afterEach(async () => {
  // The alerts hang off the events about each profile, so removing the events removes the alerts too.
  await f.admin.from('event_outbox').delete().in('aggregate_id', made.clients)
  await f.admin.from('client_merges').delete().in('kept_client_id', made.clients)
  await f.admin.from('command_requests').delete().eq('scope', `admin-client-merge:${f.user.id}`)
  for (const id of made.clients) {
    await f.admin.from('bookings').delete().eq('client_id', id)
    await f.admin.from('clients').delete().eq('id', id)
  }
  for (const id of made.users) await f.admin.auth.admin.deleteUser(id)
  await f?.cleanup()
})

const options = { auth: { persistSession: false, autoRefreshToken: false } }
const unique = () => crypto.randomUUID().slice(0, 8)
const phone = () => `07911 ${String(Math.floor(Math.random() * 900000) + 100000)}`
async function signIn(page, path = '/admin/alerts') {
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
// A profile made by a guest session, as a real guest booking makes it.
async function guestProfile({ email, first = 'Olo', last = 'Ehe', number = phone() }) {
  const session = createClient(f.config.API_URL, f.config.ANON_KEY, options)
  const { user } = await unwrap(session.auth.signInAnonymously())
  made.users.push(user.id)
  const [row] = await unwrap(session.rpc('activate_guest_client_account', { p_first_name: first, p_last_name: last, p_email: email, p_phone: number }))
  made.clients.push(row.client_id)
  return row.client_id
}
// A profile made when someone registers with a confirmed email, as a real registration makes it.
async function registered({ email, first = 'Olo', last = 'Ehe', number = null }) {
  const password = `E2e-${crypto.randomUUID()}`
  const { user } = await unwrap(f.admin.auth.admin.createUser({ email, password, email_confirm: true }))
  made.users.push(user.id)
  const session = createClient(f.config.API_URL, f.config.ANON_KEY, options)
  await unwrap(session.auth.signInWithPassword({ email, password }))
  const [row] = await unwrap(session.rpc('activate_my_client_account', { p_first_name: first, p_last_name: last, p_phone: number }))
  made.clients.push(row.client_id)
  return row.client_id
}
// A profile the Admin made, with no login.
async function added({ first, last, email = null, number = phone() }) {
  const row = await unwrap(f.admin.from('clients').insert({ first_name: first, last_name: last, email, phone: number }).select().single())
  made.clients.push(row.id)
  return row.id
}
async function booking(clientId, days) {
  const row = await unwrap(f.admin.from('bookings').insert({ client_id: clientId, service_area_id: f.ids.area, date: shiftDate(f.date, days), start_minutes: 840, treatment_duration_minutes: 60,
    booking_status: 'confirmed', source_channel: 'web', address_snapshot: '12 Garden Road, London, SW1A 1AA',
    service_area_name_snapshot: 'Test area', service_subtotal_gbp: 85, total_gbp: 85, booking_reference: `SAME-${crypto.randomUUID()}` }).select().single())
  await unwrap(f.admin.from('booking_payments').insert({ booking_id: row.id, method: 'cash', status: 'approved', amount_gbp: 85 }))
  return row.id
}
const nav = page => page.getByRole('navigation', { name: 'Admin navigation' })
const heading = (page, name) => page.getByRole('heading', { name, level: 1 })

test('a guest who registers later is not turned away, and the Admin is asked before anything is combined', async ({ page }) => {
  await f.authorize()
  const email = `e2e-same-${unique()}@example.test`
  const guest = await guestProfile({ email })
  await booking(guest, 3)
  await unwrap(f.admin.from('client_notes').insert({ client_id: guest, note: 'Prefers a firm touch.' }))
  const login = await registered({ email })          // used to be refused: "already linked to another client account"
  await signIn(page)
  await expect(heading(page, 'Alerts')).toBeVisible()
  const card = page.locator('.admin-alerts li').filter({ hasText: 'Is this the same person?' })
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Olo Ehe (has a login) and Olo Ehe (booked as a guest) have the same email.')
  await expect(nav(page).getByLabel('1 unread')).toBeVisible()
  await card.getByRole('button').click()
  // The two profiles, side by side: the one with the login stays.
  await expect(heading(page, 'Same person?')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/admin/clients/combine\\?a=${login}&b=${guest}$`))
  const withLogin = page.getByRole('article', { name: 'Olo Ehe, has a login' })
  const asGuest = page.getByRole('article', { name: 'Olo Ehe, booked as a guest' })
  await expect(withLogin).toContainText('Stays')
  await expect(withLogin).toContainText('No bookings yet')
  await expect(asGuest).toContainText('Joins the other')
  await expect(asGuest).toContainText('1 booking')
  await expect(asGuest).toContainText('1 note')
  await expect(page.getByText('They share the same email.')).toBeVisible()
  await expect(page.getByText('There is no undo.')).toBeVisible()
  // Nothing has happened yet; combining asks once more.
  await page.getByRole('button', { name: 'Yes, combine them' }).click()
  await expect(page.locator('.admin-combine-confirm')).toContainText('This cannot be undone from the app.')
  await expect(page.locator('.admin-combine-confirm')).toContainText('Olo Ehe will then see and change these bookings only by signing in.')
  // Focus moves with the panel, to the safe choice, and comes back when she says "Not yet".
  await expect(page.getByRole('button', { name: 'Not yet' })).toBeFocused()
  await page.getByRole('button', { name: 'Not yet' }).click()
  await expect(page.getByRole('button', { name: 'Yes, combine them' })).toBeFocused()
  expect((await f.admin.from('clients').select('id').eq('id', guest)).data).toHaveLength(1)
  await page.getByRole('button', { name: 'Yes, combine them' }).click()
  await page.getByRole('button', { name: 'Yes, combine', exact: true }).click()
  await expect(heading(page, 'Olo Ehe')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/admin/clients/${login}$`))
  await expect(page.getByText('Moved 1 booking and 1 note.')).toBeVisible()
  await expect(page.locator('.admin-client-bookings li')).toHaveCount(1)
  await expect(page.locator('.admin-note-list')).toContainText('Prefers a firm touch.')
  await expect(page.locator('.admin-note-list')).toContainText('Combined with another profile on')
  // The database agrees, and the question is answered: no unread alert is left.
  expect((await f.admin.from('clients').select('id').eq('id', guest)).data).toEqual([])
  expect((await f.admin.from('bookings').select('client_id').eq('client_id', login)).data).toHaveLength(1)
  await expect(nav(page).getByLabel(/unread/)).toHaveCount(0)
  await nav(page).getByRole('link', { name: 'Alerts' }).click()
  await expect(page.locator('.admin-alerts li.is-unread')).toHaveCount(0)
})

test('"Decide later" changes nothing, and "No, different people" is remembered', async ({ page }) => {
  await f.authorize()
  const email = `e2e-same-${unique()}@example.test`
  const first = await added({ first: 'Dee', last: 'Shared', email })
  const second = await guestProfile({ email, first: 'Dan', last: 'Shared' })
  await signIn(page, '/admin/clients')
  const note = page.getByRole('region', { name: 'Might be the same person' })
  await expect(note).toBeVisible()
  await expect(note).toContainText('Same email · added by you and booked as a guest')
  await note.getByRole('button', { name: /Shared and .*Shared/ }).click()
  await expect(heading(page, 'Same person?')).toBeVisible()
  // Different first names: a warning, and "Yes" is no louder than "No".
  await expect(page.getByText('The first names are different, so check that these really are the same person.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Yes, combine them' })).not.toHaveClass(/btn--primary/)
  await page.getByRole('button', { name: 'Decide later' }).click()
  await expect(heading(page, 'Clients')).toBeVisible()
  await expect(note).toBeVisible()
  await note.getByRole('button', { name: /Shared and .*Shared/ }).click()
  await page.getByRole('button', { name: 'No, different people' }).click()
  await expect(page.getByText('Got it. I will not ask about these two again.')).toBeVisible()
  await expect(heading(page, 'Clients')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Might be the same person' })).toHaveCount(0)
  expect((await f.admin.from('client_not_same').select('client_a').in('client_a', [first, second])).data).toHaveLength(1)
  expect((await f.admin.from('clients').select('id').in('id', [first, second])).data).toHaveLength(2)
  // Looking at them again by hand says so, and offers no second "different people" answer.
  await page.goto(`/admin/clients/combine?a=${first}&b=${second}`)
  await expect(page.getByText('You have already said these two are different people.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'No, different people' })).toHaveCount(0)
  // People who share an email can still have their details corrected.
  await page.goto(`/admin/clients/${first}`)
  await page.getByRole('button', { name: 'Edit details' }).click()
  const form = page.getByRole('region', { name: 'Edit details' })
  await form.getByLabel('Last name').fill('Renamed')
  await form.getByRole('button', { name: 'Save details' }).click()
  await expect(heading(page, 'Dee Renamed')).toBeVisible()
})

test('a match on a phone number alone is a warning, because the number was never checked', async ({ page }) => {
  await f.authorize()
  const number = phone()
  const first = await added({ first: 'Rae', last: 'Phone', email: `e2e-same-${unique()}@example.test`, number })
  const second = await added({ first: 'Rae', last: 'Number', email: `e2e-same-${unique()}@example.test`, number })
  await signIn(page, `/admin/clients/combine?a=${first}&b=${second}`)
  await expect(page.getByText('They share the same phone number.')).toBeVisible()
  await expect(page.locator('.admin-combine-caution')).toHaveCount(1)
  await expect(page.locator('.admin-combine-caution')).toContainText('They share a phone number but not an email.')
  await expect(page.getByRole('button', { name: 'Yes, combine them' })).not.toHaveClass(/btn--primary/)
  await expect(page.getByRole('button', { name: 'No, different people' })).not.toHaveClass(/btn--primary/)
})

test('two profiles with no login can be combined by hand from a client\'s page, keeping either', async ({ page }) => {
  await f.authorize()
  const first = await added({ first: 'Maya', last: 'Older', email: `e2e-same-${unique()}@example.test` })
  const second = await added({ first: 'Maya', last: 'Newer', email: `e2e-same-${unique()}@example.test` })
  await booking(first, 4)
  await booking(second, 5)
  await booking(second, 6)
  await signIn(page, `/admin/clients/${first}`)
  await expect(heading(page, 'Maya Older')).toBeVisible()
  await page.getByRole('button', { name: 'Combine with another client…' }).click()
  const picker = page.getByRole('region', { name: 'Combine with another client' })
  await picker.getByLabel('Find the other client by name, phone or email').fill('Maya Newer')
  await picker.getByRole('button', { name: /Maya Newer/ }).click()
  await expect(heading(page, 'Same person?')).toBeVisible()
  await expect(page.getByText('They do not share an email or a phone number.')).toBeVisible()
  // With no login on either side she chooses; the one with more bookings is suggested.
  await expect(page.getByRole('radiogroup', { name: 'Which profile stays' })).toBeVisible()
  await expect(page.locator('.admin-combine-caution')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Yes, combine them' })).toHaveClass(/btn--primary/)
  const older = page.getByRole('article', { name: 'Maya Older, added by you' })
  const newer = page.getByRole('article', { name: 'Maya Newer, added by you' })
  await expect(newer.getByLabel('Keep this one')).toBeChecked()
  await expect(newer).toContainText('Stays')
  await older.getByLabel('Keep this one').check()
  await expect(older).toContainText('Stays')
  await expect(newer).toContainText('Joins the other')
  await page.getByRole('button', { name: 'Yes, combine them' }).click()
  await expect(page.locator('.admin-combine-confirm')).toContainText('Combine Maya Newer (added by you) into Maya Older (added by you) for good?')
  await page.getByRole('button', { name: 'Yes, combine', exact: true }).click()
  await expect(heading(page, 'Maya Older')).toBeVisible()
  await expect(page.locator('.admin-client-bookings li')).toHaveCount(3)
  expect((await f.admin.from('clients').select('id').eq('id', second)).data).toEqual([])
  const history = (await f.admin.from('client_merges').select('kept_client_id,removed_client_id,removed_kind').eq('kept_client_id', first)).data
  expect(history).toEqual([{ kept_client_id: first, removed_client_id: second, removed_kind: 'added' }])
})

test('two profiles that each have a login cannot be combined, and the screen says why', async ({ page }) => {
  await f.authorize()
  const one = await registered({ email: `e2e-same-${unique()}@example.test`, first: 'Pat', last: 'First' })
  const two = await registered({ email: `e2e-same-${unique()}@example.test`, first: 'Pat', last: 'Second' })
  await signIn(page, `/admin/clients/${one}`)
  await page.getByRole('button', { name: 'Combine with another client…' }).click()
  await page.getByLabel('Find the other client by name, phone or email').fill('Pat Second')
  await page.getByRole('button', { name: /Pat Second/ }).click()
  await expect(heading(page, 'Same person?')).toBeVisible()
  await expect(page.getByText('These two each have their own login, so they cannot be combined.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Yes, combine them' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'No, different people' })).toBeVisible()
  // Nothing is promised that will not happen: neither card says it stays or joins the other.
  await expect(page.getByText('Stays')).toHaveCount(0)
  await expect(page.getByText('Joins the other')).toHaveCount(0)
  // Even if the server is asked directly, it refuses and nothing moves.
  const refused = await f.client.rpc('admin_merge_clients', { p_keep_client_id: one, p_remove_client_id: two, p_request_id: crypto.randomUUID() })
  expect(refused.error?.message).toBe('Two clients who each have their own login cannot be combined.')
  expect((await f.admin.from('clients').select('id').in('id', [one, two])).data).toHaveLength(2)
})

test('a profile that is already gone is explained kindly, and an unrelated address is not a page', async ({ page }) => {
  await f.authorize()
  const email = `e2e-same-${unique()}@example.test`
  const keep = await registered({ email })
  await signIn(page, `/admin/clients/combine?a=${keep}&b=${crypto.randomUUID()}`)
  await expect(heading(page, 'Same person?')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText('One of these clients is no longer there. They may already have been combined.')
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Back to Clients' }).click()
  await expect(heading(page, 'Clients')).toBeVisible()
  await page.goto('/admin/clients/combine?a=nonsense&b=nonsense')
  await expect(page.getByRole('heading', { name: 'Admin page not found' })).toBeVisible()
  await page.goto(`/admin/clients/combine?a=${keep}&b=${keep}`)
  await expect(page.getByRole('heading', { name: 'Admin page not found' })).toBeVisible()
})

for (const width of [320, 360, 430]) {
  test(`the two profiles and their buttons fit a ${width}px phone`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await f.authorize()
    const first = await added({ first: 'Olo', last: 'Ehe-Longsurname', email: `e2e-same-a-very-long-address-${unique()}@example.test` })
    await booking(first, 3)
    const login = await registered({ email: `e2e-same-another-very-long-address-${unique()}@example.test`, first: 'Olo', last: 'Ehe-Longsurname' })
    await signIn(page, `/admin/clients/combine?a=${login}&b=${first}`)
    await expect(heading(page, 'Same person?')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Yes, combine them' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const cards = await page.locator('.admin-combine-card').evaluateAll(items => items.map(item => { const r = item.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)] }))
    expect(cards.every(([left, right]) => left >= 0 && right <= width)).toBe(true)
    // Small phones stack the two profiles; larger ones put them side by side.
    expect(new Set(cards.map(([left]) => left)).size).toBe(width < 360 ? 1 : 2)
  })
}
