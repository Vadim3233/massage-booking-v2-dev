import { localFixture } from './localSupabase.js'
import { unwrap } from '../src/client/booking/bookingApi.js'

// Every write is scoped to a fixture-owned identity on local Supabase.
export async function newBookingFixture(offset = 55) {
  const f = await localFixture(offset)
  const user = (await f.client.auth.getUser()).data.user
  const recipientIds = []
  await unwrap(f.admin.from('admin_users').insert({ user_id: user.id }))
  const recipient = await unwrap(f.admin.from('clients').insert({
    first_name: 'NewBooking', last_name: `Recipient ${crypto.randomUUID()}`,
    email: `recipient-${crypto.randomUUID()}@example.test`, phone: '+447700900123',
  }).select().single())
  recipientIds.push(recipient.id)
  const addresses = await unwrap(f.admin.from('client_addresses').insert([
    { client_id: recipient.id, label: 'Home', address_line_1: '10 Saved Street', city: 'London', postcode: 'SW1A 1AA', entry_instructions: 'Use side entrance', is_default: true },
    { client_id: recipient.id, label: 'Office', address_line_1: '20 Office Street', city: 'London', postcode: 'SW1A 2AA', is_default: false },
  ]).select())
  return { ...f, recipient, addresses, user,
    trackRecipient(id) { recipientIds.push(id) },
    async cleanup() {
      for (const id of recipientIds) {
        const bookings = await unwrap(f.admin.from('bookings').select('id').eq('client_id', id))
        for (const booking of bookings) await unwrap(f.admin.from('event_outbox').delete().eq('aggregate_id', booking.id))
        await unwrap(f.admin.from('bookings').delete().eq('client_id', id))
        await unwrap(f.admin.from('clients').delete().eq('id', id))
      }
      await unwrap(f.admin.from('command_requests').delete().eq('actor_id', user.id))
      await f.cleanup()
    },
  }
}
