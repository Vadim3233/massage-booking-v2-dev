import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminFixture } from '../../tests/adminFixture.js'
import { unwrap } from '../client/booking/bookingApi.js'
import { createReceiptsApi } from './receiptsApi.js'

describe('receipts through the Admin API, against local Supabase', () => {
  let f, api, before
  let authorized = false
  // The Admin is made once; the first test checks the doors are shut before that.
  const authorize = async () => { if (!authorized) { await f.authorize(); authorized = true } }
  const year = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric' }).format(new Date())
  const markPaid = bookingId => unwrap(f.admin.from('booking_payments').update({ status: 'paid', paid_at: new Date(Date.now() - 86400000).toISOString() }).eq('booking_id', bookingId))
  // A further paid booking like the first one, at another time of the same day.
  const KEEP = ['client_id', 'service_area_id', 'date', 'treatment_duration_minutes', 'booking_status', 'source_channel', 'address_snapshot', 'service_area_name_snapshot', 'service_subtotal_gbp', 'total_gbp', 'booking_email_snapshot']
  const extraBooking = async startMinutes => {
    const row = await unwrap(f.admin.from('bookings').insert({ ...Object.fromEntries(KEEP.map(key => [key, f.bookings[0][key]])), start_minutes: startMinutes, booking_reference: `EXTRA-${crypto.randomUUID()}` }).select().single())
    await unwrap(f.admin.from('booking_sessions').insert({ booking_id: row.id, position: 1, service_id: f.ids.service, duration_minutes: 60, service_name_snapshot: `Session ${row.booking_reference}`, unit_price_gbp: 85 }))
    await unwrap(f.admin.from('booking_payments').insert({ booking_id: row.id, method: 'cash', status: 'approved', amount_gbp: 85 }))
    await markPaid(row.id)
    return row
  }
  const deliveries = async bookingId => unwrap(f.admin.from('event_outbox').select('id,notification_deliveries(channel,audience,recipient,title,body,status)').eq('aggregate_id', bookingId).eq('event_type', 'booking.receipt_emailed'))

  beforeAll(async () => {
    f = await adminFixture(42)
    api = createReceiptsApi(f.client)
    // Anything that was here before (a receipt made by hand on this machine) is put back afterwards.
    before = {
      settings: (await f.admin.from('business_settings').select('*').eq('key', 'receipt_details')).data ?? [],
      counters: (await f.admin.from('receipt_counters').select('*')).data ?? [],
    }
    await f.admin.from('business_settings').delete().eq('key', 'receipt_details')
    await f.admin.from('receipt_counters').delete().neq('year', 0)
  }, 30000)
  afterAll(async () => {
    // Every booking of the test's client, including the extra ones a test made: a booking cannot be deleted while it has a receipt.
    const ids = ((await f.admin.from('bookings').select('id').eq('client_id', f.bookings[0].client_id)).data ?? []).map(row => row.id)
    const receipts = (await f.admin.from('booking_receipts').select('id').in('booking_id', ids)).data ?? []
    if (receipts.length) await f.admin.from('booking_receipt_revisions').delete().in('receipt_id', receipts.map(row => row.id))
    await f.admin.from('booking_receipts').delete().in('booking_id', ids)
    await f.admin.from('event_outbox').delete().in('aggregate_id', ids)
    await f.admin.from('business_settings').delete().eq('key', 'receipt_details')
    await f.admin.from('receipt_counters').delete().neq('year', 0)
    if (before.settings.length) await f.admin.from('business_settings').insert(before.settings)
    if (before.counters.length) await f.admin.from('receipt_counters').insert(before.counters)
    await f?.cleanup()
  }, 30000)

  it('is closed to anyone who is not the Admin', async () => {
    for (const client of [f.client, f.publicClient]) {
      const blocked = createReceiptsApi(client)
      await expect(blocked.details()).rejects.toThrow('Could not complete that.')
      await expect(blocked.saveDetails({ name: 'X', email: 'x@example.test' })).rejects.toThrow('Could not complete that.')
      await expect(blocked.issue(f.bookings[0].id)).rejects.toThrow('Could not complete that.')
      await expect(blocked.edit(f.bookings[0].id, { note: 'x' })).rejects.toThrow('Could not complete that.')
      await expect(blocked.email(f.bookings[0].id, crypto.randomUUID())).rejects.toThrow('Could not complete that.')
      for (const table of ['booking_receipts', 'booking_receipt_revisions', 'receipt_counters']) expect((await client.from(table).select('*')).error).toBeTruthy()
    }
  })

  it('keeps her details, with plain sentences when something is missing', async () => {
    await authorize()
    expect(await api.details()).toBeNull()
    await expect(api.saveDetails({ name: '', phone: '07700 900123' })).rejects.toThrow('Enter your business name')
    await expect(api.saveDetails({ name: 'VadMassage' })).rejects.toThrow('Add a phone number or an email address for the receipt')
    await expect(api.saveDetails({ name: 'VadMassage', email: 'nonsense' })).rejects.toThrow('That email address does not look right')
    await api.saveDetails({ name: ' VadMassage ', phone: '07700 900123', email: 'Hello@VadMassage.example', address: '1 Example Street', closing: 'Thank you.' })
    expect(await api.details()).toEqual({ name: 'VadMassage', phone: '07700 900123', email: 'hello@vadmassage.example', address: '1 Example Street', closing: 'Thank you.' })
  })

  it('makes a receipt only for a payment that has been received, and gives the same one every time', async () => {
    await authorize()
    const [paid, cancelled] = f.bookings
    await f.admin.from('business_settings').delete().eq('key', 'receipt_details')
    await expect(api.issue(paid.id)).rejects.toThrow('A receipt can be made once the payment is marked as received')
    await api.saveDetails({ name: 'VadMassage', phone: '07700 900123' })
    await expect(api.issue(paid.id)).rejects.toThrow('A receipt can be made once the payment is marked as received')
    await expect(api.issue(cancelled.id)).rejects.toThrow('A cancelled booking has no receipt')
    await markPaid(paid.id)
    const receipt = await api.issue(paid.id)
    expect(receipt.number).toBe(`VM-${year}-0001`)
    expect(receipt.snapshot).toMatchObject({ reference: paid.booking_reference, total: 85, business: { name: 'VadMassage', phone: '07700 900123' }, payment: { method: 'cash' } })
    expect(receipt.snapshot.lines.map(line => [line.label, Number(line.amount)])).toEqual([['Session ' + paid.booking_reference + ', 60 minutes', 85]])
    expect(receipt.message).toContain(`Receipt VM-${year}-0001`)
    expect(receipt.message).toContain('Total paid: £85.00')
    expect(JSON.stringify(receipt)).not.toContain('VeryLongStreet')
    expect((await api.issue(paid.id)).id).toBe(receipt.id)
    const next = f.bookings[2]
    await markPaid(next.id)
    expect((await api.issue(next.id)).number).toBe(`VM-${year}-0002`)
  })

  it('lets the words be corrected, never the amounts, and keeps what it said before', async () => {
    await authorize()
    const booking = f.bookings[0]
    const receipt = await api.issue(booking.id)
    const edited = await api.edit(booking.id, { billed_to: 'Jensen Holdings Ltd', note: 'Order 4471', lines: ['Sports massage, 60 minutes'], business: { name: 'VadMassage Ltd', phone: '07700 900123', email: '', address: '', closing: '' } })
    expect(edited).toMatchObject({ number: receipt.number, edit_count: 1 })
    expect(edited.snapshot).toMatchObject({ billed_to: 'Jensen Holdings Ltd', note: 'Order 4471', total: 85, business: { name: 'VadMassage Ltd' } })
    expect(edited.snapshot.lines).toEqual([{ label: 'Sports massage, 60 minutes', amount: 85 }])
    const revisions = await unwrap(f.admin.from('booking_receipt_revisions').select('revision,snapshot').eq('receipt_id', receipt.id))
    expect(revisions).toHaveLength(1)
    expect(revisions[0].snapshot.billed_to).toBe(receipt.snapshot.billed_to)
    await expect(api.edit(booking.id, { billed_to: ' ' })).rejects.toThrow('Enter who the receipt is for')
    await expect(api.edit(booking.id, { lines: [''] })).rejects.toThrow('Every line of the receipt needs its words')
    await expect(api.edit(booking.id, { lines: [{ label: 'x', amount: 1 }] })).rejects.toThrow('Every line of the receipt needs its words')
    await expect(api.edit(booking.id, { total: 1 })).rejects.toThrow('Invalid receipt changes')
    await expect(api.edit(f.bookings[1].id, { note: 'x' })).rejects.toThrow('This booking has no receipt yet')
    expect(Number((await api.issue(booking.id)).snapshot.total)).toBe(85)
  })

  it('emails the receipt once for each press, to the address on the booking', async () => {
    await authorize()
    const booking = f.bookings[0]
    const request = crypto.randomUUID()
    const sent = await api.email(booking.id, request)
    expect(sent.emailed_to).toBe('booking@example.test')
    expect(sent.emailed_at).toBeTruthy()
    await api.email(booking.id, request)
    let queued = (await deliveries(booking.id)).flatMap(row => row.notification_deliveries)
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ channel: 'email', audience: 'client', recipient: 'booking@example.test', status: 'pending' })
    expect(queued[0].title).toBe(`Your receipt from VadMassage Ltd (VM-${year}-0001)`)
    expect(queued[0].body).toContain('Total paid: £85.00')
    await api.email(booking.id, crypto.randomUUID())
    queued = (await deliveries(booking.id)).flatMap(row => row.notification_deliveries)
    expect(queued).toHaveLength(2)
    await expect(api.email(f.bookings[1].id, crypto.randomUUID())).rejects.toThrow('This booking has no receipt yet')
  })

  it('looks at a receipt without making one, and says what became of its email', async () => {
    await authorize()
    const [booking, , other] = f.bookings
    expect((await api.get(other.id)).number).toBe(`VM-${year}-0002`)
    expect(await api.get(f.bookings[1].id)).toBeNull()
    expect((await unwrap(f.admin.from('booking_receipts').select('id').eq('booking_id', f.bookings[1].id)))).toEqual([])
    // Queued, then delivered by the sender: the receipt reports the newest email, never more than is true.
    const first = await api.email(booking.id, crypto.randomUUID())
    expect(first.email).toMatchObject({ status: 'pending', to: 'booking@example.test', attempts: 0, sent_at: null })
    const latest = (await unwrap(f.admin.from('event_outbox').select('id,created_at,notification_deliveries(id)').eq('aggregate_id', booking.id).eq('event_type', 'booking.receipt_emailed').order('created_at', { ascending: false }).limit(1)))[0]
    await unwrap(f.admin.from('notification_deliveries').update({ status: 'failed', attempt_count: 2, last_error: 'The mail service refused it' }).eq('id', latest.notification_deliveries[0].id))
    const failed = await api.get(booking.id)
    expect(failed.email).toMatchObject({ status: 'failed', attempts: 2 })
    expect(JSON.stringify(failed)).not.toContain('The mail service refused it')
    await unwrap(f.admin.from('notification_deliveries').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', latest.notification_deliveries[0].id))
    expect((await api.get(booking.id)).email).toMatchObject({ status: 'sent' })
  })

  it('notices a moved appointment and brings the receipt up to date on request', async () => {
    await authorize()
    const booking = f.bookings[0]
    expect((await api.get(booking.id)).changes).toEqual({ appointment: false, total: false })
    await unwrap(f.admin.from('bookings').update({ start_minutes: 660 }).eq('id', booking.id))
    expect((await api.get(booking.id)).changes).toEqual({ appointment: true, total: false })
    const updated = await api.edit(booking.id, { sync_appointment: true })
    expect(updated.snapshot.appointment).toMatchObject({ start_minutes: 660, duration_minutes: 60 })
    expect(updated.snapshot.total).toBe(85)
    expect(updated.changes).toEqual({ appointment: false, total: false })
    await expect(api.edit(booking.id, { sync_appointment: 'yes' })).rejects.toThrow('Invalid receipt changes')
  })

  it('refuses odd characters, and never lets the sender\'s link word through', async () => {
    await authorize()
    const booking = f.bookings[0]
    await expect(api.edit(booking.id, { note: 'Hello' + String.fromCodePoint(0x202e) + 'there' })).rejects.toThrow('That contains characters that cannot be used')
    await expect(api.edit(booking.id, { billed_to: 'A\u0007B' })).rejects.toThrow('That contains characters that cannot be used')
    const edited = await api.edit(booking.id, { billed_to: 'Jensen\nHoldings', note: 'Open {link} now' })
    expect(edited.snapshot.billed_to).toBe('Jensen Holdings')
    expect(edited.message).not.toContain('{link}')
  })

  it('never makes two receipts for one booking, or skips a number, when pressed at the same moment', async () => {
    await authorize()
    const [first, second, third] = [await extraBooking(900), await extraBooking(1020), await extraBooking(1140)]
    const same = await Promise.all([api.issue(first.id), api.issue(first.id), api.issue(first.id)])
    expect(new Set(same.map(receipt => receipt.id)).size).toBe(1)
    expect(await unwrap(f.admin.from('booking_receipts').select('id').eq('booking_id', first.id))).toHaveLength(1)
    // Two different bookings at once take the next two numbers, one each.
    const both = await Promise.all([api.issue(second.id), api.issue(third.id)])
    expect(both.map(receipt => receipt.number).sort()).toEqual([`VM-${year}-0004`, `VM-${year}-0005`])
    expect(same[0].number).toBe(`VM-${year}-0003`)
  })

  it('will not send or change the receipt of a booking that was cancelled, stops an email still waiting, but still shows it', async () => {
    await authorize()
    const booking = f.bookings[2]
    // An email is waiting to be sent when the booking is cancelled: it must never go.
    expect((await api.email(booking.id, crypto.randomUUID())).email.status).toBe('pending')
    await unwrap(f.admin.from('bookings').update({ booking_status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by_actor_type: 'admin' }).eq('id', booking.id))
    const message = 'This booking was cancelled, so its receipt can no longer be sent or changed'
    await expect(api.email(booking.id, crypto.randomUUID())).rejects.toThrow(message)
    await expect(api.edit(booking.id, { note: 'x' })).rejects.toThrow(message)
    const stopped = await api.get(booking.id)
    expect(stopped.number).toBe(`VM-${year}-0002`)
    expect(stopped.email).toMatchObject({ status: 'failed', attempts: 5 })
    // A missed appointment or a refunded payment is the same.
    const paid = f.bookings[0]
    await unwrap(f.admin.from('booking_payments').update({ status: 'refunded', paid_at: null }).eq('booking_id', paid.id))
    await expect(api.email(paid.id, crypto.randomUUID())).rejects.toThrow('This payment was refunded, so its receipt can no longer be sent or changed')
    await expect(api.issue(f.bookings[1].id)).rejects.toThrow('A cancelled booking has no receipt')
  })
})
