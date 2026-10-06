import { localFixture } from './localSupabase.js'
import { unwrap } from '../src/client/booking/bookingApi.js'
import { shiftDate } from '../src/admin/calendarPresentation.js'
export async function adminFixture() {
  const f = await localFixture(35)
  const user = (await f.client.auth.getUser()).data.user
  const other = await unwrap(f.admin.from('clients').insert({ first_name: 'Alexandra'.repeat(12), last_name: 'Calendar', email: 'canonical@example.test', phone: '+447700900002' }).select().single())
  const base = { client_id: other.id, service_area_id: f.ids.area, date: f.date, start_minutes: 600, treatment_duration_minutes: 60, booking_status: 'confirmed', source_channel: 'web', address_line_1_snapshot: 'VeryLongStreet'.repeat(16), city_snapshot: 'London', postcode_snapshot: 'SW1A1AA', service_area_name_snapshot: 'Test area', service_subtotal_gbp: 85, total_gbp: 85, booking_email_snapshot: 'booking@example.test', client_note: 'Exact persisted note' }
  const bookings = await unwrap(f.admin.from('bookings').insert([
    { ...base, booking_reference: `ADMIN-${crypto.randomUUID()}` },
    { ...base, start_minutes: 780, booking_status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by_actor_type: 'admin', booking_reference: `CANCELLED-${crypto.randomUUID()}` },
    { ...base, date: shiftDate(f.date, 1), booking_reference: `OUTSIDE-${crypto.randomUUID()}` },
  ]).select())
  for (const b of bookings) {
    await unwrap(f.admin.from('booking_sessions').insert({ booking_id: b.id, position: 1, service_id: f.ids.service, duration_minutes: 60, service_name_snapshot: `Session ${b.booking_reference}`, unit_price_gbp: 85 }))
    await unwrap(f.admin.from('booking_payments').insert({ booking_id: b.id, method: 'cash', status: b.booking_status === 'cancelled' ? 'rejected' : 'approved', amount_gbp: 85 }))
  }
  return { ...f, bookings, user,
    async authorize() { await unwrap(f.admin.from('admin_users').insert({ user_id: user.id })) },
    async cleanup() { await unwrap(f.admin.from('bookings').delete().eq('client_id', other.id)); await unwrap(f.admin.from('clients').delete().eq('id', other.id)); await f.cleanup() },
  }
}
