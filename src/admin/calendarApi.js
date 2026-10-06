// All requests use the signed-in user's JWT; table RLS remains authoritative.
const bookingFields = `*,clients!bookings_client_id_fkey(id,first_name,last_name,email,phone),
booking_sessions(*,booking_session_preferences(*),booking_session_enhancements(*)),
booking_payments(*),booking_enhancements(*)`
async function read(query) {
  const { data, error, count } = await query
  if (error) throw error
  if (Array.isArray(data) && count != null && count > data.length) throw new Error('Calendar result exceeds the server limit. Choose a smaller date range.')
  return data
}
export function validateRange(start, end) {
  const valid = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value
  if (!valid(start) || !valid(end) || end <= start || (Date.parse(end) - Date.parse(start)) / 86400000 > 31) throw new Error('Choose a valid calendar range of up to 31 days.')
}
export function createCalendarApi(client) {
  async function authorized() {
    const { data, error } = await client.auth.getUser()
    if (error) throw error
    if (!data.user || data.user.is_anonymous) throw new Error('Admin sign-in required.')
    if (!await read(client.rpc('is_booking_admin'))) throw new Error('This account does not have Admin access.')
  }
  return {
    async loadCalendarRange(start, end) {
      validateRange(start, end)
      await authorized()
      const bounded = (table, columns = '*') => client.from(table).select(columns, { count: 'exact' }).gte('date', start).lt('date', end)
      const weekdays = []
      for (let date = new Date(start + 'T12:00:00Z'); date < new Date(end + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate() + 1)) weekdays.push(date.getUTCDay() || 7)
      const [bookings, blocks, overrides, hours, holds] = await Promise.all([
        read(bounded('bookings', bookingFields).order('date').order('start_minutes')),
        read(bounded('calendar_blocks').order('start_minutes')),
        read(bounded('working_hours_overrides')),
        read(client.from('working_hours').select('*').in('weekday', [...new Set(weekdays)])),
        // Never request hold tokens or browser client keys.
        read(bounded('booking_holds', 'id,date,start_minutes,treatment_duration_minutes,travel_buffer_minutes,expires_at').eq('status', 'active').gt('expires_at', new Date().toISOString())),
      ])
      return { bookings, blocks, overrides, hours, holds }
    },
  }
}
