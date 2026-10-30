import { test, expect } from '@playwright/test'
import { adminFixture } from '../adminFixture.js'
import { removeReceipts } from '../localSupabase.js'
import { unwrap } from '../../src/client/booking/bookingApi.js'
import { shiftDate } from '../../src/admin/calendarPresentation.js'

let f
const created = []
const users = []
test.beforeEach(async () => {
  f = await adminFixture(36); created.length = 0; users.length = 0
  // Held times left over from other work on this database would stop every deletion.
  await f.admin.from('booking_holds').delete().not('id', 'is', null)
})
test.afterEach(async () => {
  // Events about these clients (and the alerts planned from them) go too, so nothing is left in the Admin's alerts for other tests.
  if (created.length) await f.admin.from('event_outbox').delete().in('aggregate_id', created)
  for (const id of created) {
    const ids = ((await f.admin.from('bookings').select('id').eq('client_id', id)).data ?? []).map(row => row.id)
    if (ids.length) await f.admin.from('event_outbox').delete().in('aggregate_id', ids)
    await removeReceipts(f.admin, { clientId: id })
    await f.admin.from('bookings').delete().eq('client_id', id)
    await f.admin.from('clients').delete().eq('id', id)
  }
  for (const id of users) await f.admin.auth.admin.deleteUser(id)
  await f.admin.from('booking_holds').delete().not('id', 'is', null)
  await f.admin.from('client_deletions').delete().eq('deleted_by', f.user.id)
  await f.admin.from('command_requests').delete().eq('scope', `admin-client-delete:${f.user.id}`)
  await f.admin.from('clients').delete().like('email', 'e2e-delete-%')
  await f?.cleanup()
})

async function signIn(page, path) {
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill(f.email)
  await page.getByLabel('Password', { exact: true }).fill(f.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
const randomPhone = () => `07700 9${String(Math.floor(Math.random() * 90000) + 10000)}`
async function client(overrides = {}) {
  // A phone number of its own each time: two clients sharing one raise the "same person?" alert, which would be left behind for other tests.
  const row = await unwrap(f.admin.from('clients').insert({ first_name: 'Zelda', last_name: 'Deletable', email: `e2e-delete-${crypto.randomUUID()}@example.test`, phone: randomPhone(), ...overrides }).select().single())
  created.push(row.id)
  return row
}
const address = id => unwrap(f.admin.from('client_addresses').insert({ client_id: id, label: 'Home', address: '12 Garden Road, London, SW1A 2AA' }))
const note = (id, text = 'Ring the top bell') => unwrap(f.admin.from('client_notes').insert({ client_id: id, note: text }))
async function booking(clientId) {
  const row = await unwrap(f.admin.from('bookings').insert({ client_id: clientId, service_area_id: f.ids.area, date: shiftDate(f.date, 3), start_minutes: 600, treatment_duration_minutes: 60,
    booking_status: 'confirmed', source_channel: 'web', address_snapshot: '1 Test Road, London, SW1A 1AA',
    service_area_name_snapshot: 'Test area', service_subtotal_gbp: 85, total_gbp: 85, booking_reference: `E2EDEL-${crypto.randomUUID()}` }).select().single())
  await unwrap(f.admin.from('booking_payments').insert({ booking_id: row.id, method: 'cash', status: 'approved', amount_gbp: 85 }))
  return row
}
// A held time the way a visitor makes one: no client attached, only the browser's key.
const hold = () => unwrap(f.admin.from('booking_holds').insert({ client_id: null, client_key: `e2e-delete-hold-key-${crypto.randomUUID().slice(0, 12)}`, date: shiftDate(f.date, 5), start_minutes: 600,
  treatment_duration_minutes: 60, expires_at: new Date(Date.now() + 10 * 60000).toISOString(), status: 'active' }).select().single())
const profile = (page, name) => page.getByRole('heading', { name, level: 1 })
const section = page => page.getByRole('region', { name: 'Delete this client' })
const exists = async id => Boolean((await f.admin.from('clients').select('id').eq('id', id).maybeSingle()).data)
const deletions = async () => (await f.admin.from('client_deletions').select('client_id,summary').eq('deleted_by', f.user.id)).data ?? []
const open = (page, name = 'Delete this client…') => section(page).getByRole('button', { name })

test('a client with no bookings is deleted after a question that says what goes', async ({ page }) => {
  await f.authorize()
  const row = await client()
  await address(row.id)
  await note(row.id)
  await signIn(page, `/admin/clients/${row.id}`)
  await expect(profile(page, 'Zelda Deletable')).toBeVisible()
  await expect(section(page)).toContainText('For someone added by mistake, a profile made twice or a made-up test profile.')
  await open(page).click()
  await expect(section(page).getByRole('group')).toContainText("Delete Zelda Deletable? Their details, 1 saved address and 1 note will be removed for good. This can't be undone.")
  // The safe choice has focus and is read out with the question; changing her mind puts her back where she was.
  await expect(open(page, 'Keep Zelda')).toBeFocused()
  await expect(open(page, 'Keep Zelda')).toHaveAccessibleDescription(/Delete Zelda Deletable\?/)
  await expect(open(page, 'Yes, delete Zelda')).toHaveAccessibleDescription(/can't be undone/)
  await open(page, 'Keep Zelda').click()
  await expect(section(page).getByRole('group')).toHaveCount(0)
  await expect(open(page)).toBeFocused()
  expect(await exists(row.id)).toBe(true)
  await open(page).click()
  await open(page, 'Yes, delete Zelda').click()
  await expect(page.getByRole('heading', { name: 'Clients', level: 1 })).toBeVisible()
  await expect(page).toHaveURL(/\/admin\/clients$/)
  await expect(page.getByText('Zelda Deletable was deleted.')).toBeVisible()
  expect(await exists(row.id)).toBe(false)
  expect((await f.admin.from('client_addresses').select('id').eq('client_id', row.id)).data).toEqual([])
  expect((await f.admin.from('client_notes').select('id').eq('client_id', row.id)).data).toEqual([])
  const record = await deletions()
  expect(record).toHaveLength(1)
  expect(record[0].client_id).toBe(row.id)
  expect(record[0].summary).toMatchObject({ addresses: 1, notes: 1, waitlist: 0, login: 'added' })
  expect(JSON.stringify(record[0].summary)).not.toMatch(/zelda|deletable|example\.test|garden|top bell/i)
  await page.getByLabel('Search by name, phone or email').fill('Deletable')
  await expect(page.getByText('No one matches that search.')).toBeVisible()
})

test('a client with bookings is told why not, and there is nothing to press', async ({ page }) => {
  await f.authorize()
  const owner = f.bookings[0].client_id
  const count = (await f.admin.from('bookings').select('id').eq('client_id', owner)).data.length
  await signIn(page, `/admin/clients/${owner}`)
  await expect(page.getByRole('heading', { name: 'Bookings' })).toBeVisible()
  await expect(section(page)).toContainText(`has ${count} bookings, so they can't be deleted. Bookings, payments and receipts are your records, so they stay. To stop them booking online, switch off online booking above.`)
  await expect(section(page).getByRole('button')).toHaveCount(0)
  expect(await exists(owner)).toBe(true)
})

test('a booking made while the page was open is noticed before asking, and read out', async ({ page }) => {
  await f.authorize()
  const first = await client({ first_name: 'Bea', last_name: 'Early' })
  await signIn(page, `/admin/clients/${first.id}`)
  await expect(open(page)).toBeVisible()
  // Someone books them after the page loaded: pressing Delete looks again and says why not, and focus goes to the words.
  await booking(first.id)
  await open(page).click()
  const reason = section(page).getByText("Bea Early has 1 booking, so they can't be deleted.")
  await expect(reason).toBeVisible()
  await expect(reason).toBeFocused()
  await expect(section(page).getByRole('button')).toHaveCount(0)
  expect(await exists(first.id)).toBe(true)
})

test('a booking made after the question is on screen is caught at the last press', async ({ page }) => {
  await f.authorize()
  const row = await client({ first_name: 'Cal', last_name: 'Late' })
  await signIn(page, `/admin/clients/${row.id}`)
  await open(page).click()
  await expect(open(page, 'Yes, delete Cal')).toBeVisible()
  await booking(row.id)
  await open(page, 'Yes, delete Cal').click()
  await expect(section(page).getByRole('alert')).toContainText('This client has bookings, so they cannot be deleted. Bookings, payments and receipts are your records.')
  await expect(section(page).getByRole('alert')).toBeFocused()
  await expect(section(page)).toContainText("Cal Late has 1 booking, so they can't be deleted.")
  await expect(section(page).getByRole('group')).toHaveCount(0)
  expect(await exists(row.id)).toBe(true)
  expect(await deletions()).toEqual([])
})

test('something changing after the question is put means being asked again, not deleting what she was not told about', async ({ page }) => {
  await f.authorize()
  const row = await client({ first_name: 'Nan', last_name: 'Notes' })
  await note(row.id)
  await signIn(page, `/admin/clients/${row.id}`)
  await open(page).click()
  await expect(section(page).getByRole('group')).toContainText('Their details and 1 note will be removed for good.')
  await note(row.id, 'Added after the question')
  await open(page, 'Yes, delete Nan').click()
  await expect(section(page).getByRole('alert')).toHaveText('Something changed while you were deciding. Please look at the question again.')
  await expect(section(page).getByRole('alert')).toBeFocused()
  await expect(section(page).getByRole('group')).toHaveCount(0)
  expect(await exists(row.id)).toBe(true)
  await open(page).click()
  await expect(section(page).getByRole('group')).toContainText('Their details and 2 notes will be removed for good.')
  await open(page, 'Yes, delete Nan').click()
  await expect(page.getByText('Nan Notes was deleted.')).toBeVisible()
  expect(await exists(row.id)).toBe(false)
})

test('while someone is booking nothing can be deleted, and Check again finds when it is over', async ({ page }) => {
  await f.authorize()
  const row = await client({ first_name: 'Wes', last_name: 'Waiting' })
  const held = await hold()
  await signIn(page, `/admin/clients/${row.id}`)
  await expect(section(page)).toContainText('Someone is in the middle of booking right now, so nobody can be deleted for a few minutes. Try again soon.')
  await expect(open(page)).toHaveCount(0)
  await f.admin.from('booking_holds').update({ status: 'released' }).eq('id', held.id)
  await section(page).getByRole('button', { name: 'Check again' }).click()
  await expect(open(page)).toBeVisible()
  expect(await exists(row.id)).toBe(true)
})

test('a failure is said in plain words, read out, and she can press again', async ({ page }) => {
  await f.authorize()
  const row = await client({ first_name: 'Fay', last_name: 'Failing' })
  await signIn(page, `/admin/clients/${row.id}`)
  await open(page).click()
  await page.route('**/rest/v1/rpc/admin_delete_client', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'permission denied for table users', code: '42501' }) }))
  await open(page, 'Yes, delete Fay').click()
  await expect(section(page).getByRole('alert')).toHaveText('Could not complete that. Please check your connection and try again.')
  await expect(section(page).getByRole('alert')).toBeFocused()
  expect(await exists(row.id)).toBe(true)
  await page.unroute('**/rest/v1/rpc/admin_delete_client')
  await open(page).click()
  await open(page, 'Yes, delete Fay').click()
  await expect(page.getByText('Fay Failing was deleted.')).toBeVisible()
  expect(await exists(row.id)).toBe(false)
})

test('when the answer is lost after the client was deleted, she is told they are gone, not that it failed', async ({ page }) => {
  await f.authorize()
  const row = await client({ first_name: 'Lou', last_name: 'Lost' })
  await signIn(page, `/admin/clients/${row.id}`)
  await open(page).click()
  await page.route('**/rest/v1/rpc/admin_delete_client', async route => { await route.fetch(); await route.abort('failed') })
  await open(page, 'Yes, delete Lou').click()
  await expect(page.getByText('Lou Lost was deleted.')).toBeVisible()
  await expect(page).toHaveURL(/\/admin\/clients$/)
  expect(await exists(row.id)).toBe(false)
  expect(await deletions()).toHaveLength(1)
})

test('if the check itself fails there is a way to try again', async ({ page }) => {
  await f.authorize()
  const row = await client({ first_name: 'Chi', last_name: 'Check' })
  await page.route('**/rest/v1/rpc/admin_client_delete_check', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'boom', code: 'XX000' }) }))
  await signIn(page, `/admin/clients/${row.id}`)
  await expect(profile(page, 'Chi Check')).toBeVisible()
  await expect(section(page).getByRole('alert')).toContainText('Could not check whether this client can be deleted.')
  await page.unroute('**/rest/v1/rpc/admin_client_delete_check')
  await section(page).getByRole('button', { name: 'Try again' }).click()
  await expect(open(page)).toBeVisible()
})

test('a client who has already gone is said to be gone', async ({ page }) => {
  await f.authorize()
  const row = await client({ first_name: 'Gone', last_name: 'Already' })
  await signIn(page, `/admin/clients/${row.id}`)
  await expect(open(page)).toBeVisible()
  await f.admin.from('clients').delete().eq('id', row.id)
  await open(page).click()
  await expect(section(page)).toContainText('This client is no longer there. They may already have been deleted or combined.')
})

test('a client with a login loses it too, and the question says so', async ({ page }) => {
  await f.authorize()
  const email = `e2e-delete-${crypto.randomUUID()}@example.test`
  const { user } = await unwrap(f.admin.auth.admin.createUser({ email, password: `Test-only-${crypto.randomUUID()}`, email_confirm: true }))
  users.push(user.id)
  const row = await client({ first_name: 'Lena', last_name: 'Login', email, auth_user_id: user.id })
  await signIn(page, `/admin/clients/${row.id}`)
  await open(page).click()
  await expect(section(page).getByRole('group')).toContainText("Delete Lena Login? Their details and their online account will be removed for good. This can't be undone.")
  await open(page, 'Yes, delete Lena').click()
  await expect(page.getByText('Lena Login was deleted.')).toBeVisible()
  expect(await exists(row.id)).toBe(false)
  expect((await f.admin.auth.admin.getUserById(user.id)).data.user).toBeNull()
  expect((await deletions())[0].summary.login).toBe('registered')
})

test('deleting takes the question about the same person away with them, clears the Alerts number, and drops a half-made booking for them', async ({ page }) => {
  await f.authorize()
  const samePhone = randomPhone()
  const real = await client({ first_name: 'Pia', last_name: 'Pair', phone: samePhone })
  await booking(real.id)
  // A second profile with the same phone number, made after the first one has a booking: the app asks "Is this the same person?".
  const twin = await client({ first_name: 'Pip', last_name: 'Pair', phone: samePhone })
  await signIn(page, `/admin/clients/${twin.id}`)
  await expect(profile(page, 'Pip Pair')).toBeVisible()
  const badge = page.getByLabel('1 unread')
  await expect(badge).toBeVisible()
  await page.evaluate(({ owner, id }) => sessionStorage.setItem(`admin-new-booking:v1:${owner}`, JSON.stringify({ version: 1, draft: { client: { id }, sessions: [], details: {} } })), { owner: f.user.id, id: twin.id })
  await open(page).click()
  await open(page, 'Yes, delete Pip').click()
  await expect(page.getByText('Pip Pair was deleted.')).toBeVisible()
  await expect(badge).toHaveCount(0)
  expect(await page.evaluate(owner => sessionStorage.getItem(`admin-new-booking:v1:${owner}`), f.user.id)).toBeNull()
  expect(await exists(real.id)).toBe(true)
  const left = await f.admin.from('notification_deliveries').select('id, event_outbox!inner(event_type, payload)').eq('event_outbox.event_type', 'client.possible_duplicate')
  expect(left.data ?? []).toEqual([])
})

test('pressing Yes twice deletes once', async ({ page }) => {
  await f.authorize()
  const row = await client({ first_name: 'Dot', last_name: 'Double' })
  await signIn(page, `/admin/clients/${row.id}`)
  await open(page).click()
  await open(page, 'Yes, delete Dot').dblclick()
  await expect(page.getByText('Dot Double was deleted.')).toBeVisible()
  expect(await exists(row.id)).toBe(false)
  expect(await deletions()).toHaveLength(1)
  expect((await f.admin.from('command_requests').select('id').eq('scope', `admin-client-delete:${f.user.id}`)).data).toHaveLength(1)
})

for (const width of [390, 320]) {
  test(`the question and its buttons fit a ${width}px wide screen, even for a very long name`, async ({ page }) => {
    await f.authorize()
    await page.setViewportSize({ width, height: 800 })
    const long = await client({ first_name: 'Longname'.repeat(12), last_name: 'Lastname' })
    await address(long.id)
    await signIn(page, `/admin/clients/${long.id}`)
    await open(page).click()
    const keep = section(page).getByRole('button', { name: /^Keep / })
    const yes = section(page).getByRole('button', { name: /^Yes, delete / })
    await expect(keep).toBeVisible()
    await expect(yes).toBeVisible()
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(sideways).toBeLessThanOrEqual(0)
    for (const button of [keep, yes]) {
      const box = await button.boundingBox()
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
    }
    // A client with bookings, with the same very long name, also fits.
    const owner = f.bookings[0].client_id
    await page.goto(`/admin/clients/${owner}`)
    await expect(section(page)).toContainText("so they can't be deleted.")
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  })
}
