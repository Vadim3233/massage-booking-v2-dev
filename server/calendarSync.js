// The Google Calendar copy of the bookings (docs/google-calendar-sync-brief.md): makes the "VadMassage bookings" calendar match what the
// database says it should hold (calendar_desired_events, where all the rules are). One way only: it reads bookings and never changes one,
// and a problem with Google never reaches a booking. It runs inside the every-minute sender, with its own time limit.
// Nothing it logs or returns contains a token, and Google's own error text is never passed on (only its status and reason code).

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://www.googleapis.com/calendar/v3'
const CHECK_EVERY_MS = 15 * 60 * 1000
const FULL_CHECK_EVERY_MS = 20 * 60 * 60 * 1000
const FULL_CHECK_LONDON_HOUR = 3

export function readCalendarConfig(env) {
  return { clientId: env.GOOGLE_CLIENT_ID || '', clientSecret: env.GOOGLE_CLIENT_SECRET || '' }
}
export const calendarConfigured = config => Boolean(config.clientId && config.clientSecret)

export class GoogleError extends Error {
  constructor(status, reason) {
    super(`Google said ${status}${reason ? ` (${reason})` : ''}`)
    this.status = status
    this.reason = reason
  }
}
// Google will not work with the saved sign-in any more: the Admin has to connect again.
export class NeedsReconnect extends Error {}

// One booking's event as Google takes it. Travel events have no reminders of their own.
export function eventBody(event) {
  return {
    id: event.google_event_id,
    summary: event.title,
    ...(event.description ? { description: event.description } : {}),
    start: { dateTime: new Date(event.starts_at).toISOString(), timeZone: 'Europe/London' },
    end: { dateTime: new Date(event.ends_at).toISOString(), timeZone: 'Europe/London' },
    transparency: 'opaque',
    status: 'confirmed',
    extendedProperties: { private: { bookingId: event.booking_id, kind: event.kind } },
    ...(event.kind === 'travel' ? { reminders: { useDefault: false } } : {}),
  }
}

const londonHour = time => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23' }).format(new Date(time)))

export function createCalendarSync({ client, config, fetchImpl = fetch, now = Date.now }) {
  async function rpc(name, args) {
    const { data, error } = await client.rpc(name, args)
    if (error) throw new Error(`The database refused ${name}`)
    return data
  }
  async function reasonOf(response) {
    try { const data = await response.json(); return data?.error?.errors?.[0]?.reason || (typeof data?.error === 'string' ? data.error : data?.error?.status) || '' } catch { return '' }
  }
  async function accessToken() {
    const refreshToken = await rpc('calendar_refresh_token')
    if (!refreshToken) throw new NeedsReconnect('Google Calendar is not connected. Connect it again.')
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
    })
    if (response.ok) return (await response.json()).access_token
    const reason = await reasonOf(response)
    if (reason === 'invalid_grant' || response.status === 401) throw new NeedsReconnect('Google asked you to connect again.')
    throw new GoogleError(response.status, reason)
  }
  function google(token) {
    return async (method, path, body) => {
      const response = await fetchImpl(API + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      if (response.ok) return response.status
      const reason = await reasonOf(response)
      if (response.status === 401) throw new NeedsReconnect('Google asked you to connect again.')
      throw new GoogleError(response.status, reason)
    }
  }

  // Makes one booking's events in Google what they should be: put in, changed, or taken out.
  async function syncBooking(call, calendarId, item) {
    const events = `/calendars/${encodeURIComponent(calendarId)}/events`
    const wanted = (await rpc('calendar_desired_events', { p_booking_ids: [item.booking_id] })) || []
    const { data: synced, error } = await client.from('calendar_sync_events').select('kind,google_event_id,content_hash').eq('booking_id', item.booking_id)
    if (error) throw new Error('The database refused calendar_sync_events')
    for (const event of wanted) {
      const before = synced.find(row => row.kind === event.kind)
      if (before && !item.force && before.content_hash === event.content_hash && before.google_event_id === event.google_event_id) continue
      const body = eventBody(event)
      const path = `${events}/${encodeURIComponent(event.google_event_id)}`
      let put = false
      if (before) {
        try { await call('PUT', path, body); put = true } catch (failure) { if (![404, 410].includes(failure.status)) throw failure }
      }
      if (!put) {
        try { await call('POST', events, body) } catch (failure) {
          // Already in Google (perhaps deleted there, which Google remembers): it is brought back as it should be.
          if (failure.status === 409) await call('PUT', path, body)
          else if (failure.status === 404) throw new NeedsReconnect('The VadMassage bookings calendar was not found in Google. Connect again to make a new one.')
          else throw failure
        }
      }
      const saved = await client.from('calendar_sync_events').upsert({ booking_id: item.booking_id, kind: event.kind, google_event_id: event.google_event_id, content_hash: event.content_hash, synced_at: new Date(now()).toISOString() })
      if (saved.error) throw new Error('The database refused calendar_sync_events')
    }
    for (const before of synced.filter(row => !wanted.some(event => event.kind === row.kind))) {
      try { await call('DELETE', `${events}/${encodeURIComponent(before.google_event_id)}`) } catch (failure) { if (![404, 410].includes(failure.status)) throw failure }
      const removed = await client.from('calendar_sync_events').delete().eq('booking_id', item.booking_id).eq('kind', before.kind)
      if (removed.error) throw new Error('The database refused calendar_sync_events')
    }
  }

  // Every 15 minutes, bookings out of step with what was put in Google are queued; at about 3 in the morning everything is put in again.
  async function regularChecks(connection) {
    const at = now()
    const due = (stamp, ms) => !stamp || at - Date.parse(stamp) >= ms
    if (due(connection.last_full_check_at, FULL_CHECK_EVERY_MS) && londonHour(at) === FULL_CHECK_LONDON_HOUR) {
      const queued = await rpc('calendar_queue_all', { p_force: true })
      await client.from('calendar_connection').update({ last_full_check_at: new Date(at).toISOString(), last_check_at: new Date(at).toISOString() }).eq('id', true)
      return { full: queued }
    }
    if (due(connection.last_check_at, CHECK_EVERY_MS)) {
      const queued = await rpc('calendar_queue_out_of_step')
      await client.from('calendar_connection').update({ last_check_at: new Date(at).toISOString() }).eq('id', true)
      return { check: queued }
    }
    return {}
  }
  async function note(changes) {
    await client.from('calendar_connection').update({ ...changes, updated_at: new Date(now()).toISOString() }).eq('id', true)
  }

  return {
    async run({ budgetMs = 4000, batch = 3 } = {}) {
      const started = now()
      if (!calendarConfigured(config)) return { skipped: 'not configured' }
      const { data: connection, error } = await client.from('calendar_connection').select('status,calendar_id,last_check_at,last_full_check_at').maybeSingle()
      if (error) throw new Error('The database refused calendar_connection')
      if (connection?.status !== 'connected' || !connection.calendar_id) return { skipped: 'not connected' }
      const summary = { ...(await regularChecks(connection)), synced: 0, failed: 0 }
      let call
      let lastError = ''
      try {
        call = google(await accessToken())
        while (now() - started < budgetMs) {
          const items = (await rpc('claim_calendar_sync', { p_limit: batch })) || []
          if (!items.length) break
          for (const item of items) {
            try {
              await syncBooking(call, connection.calendar_id, item)
              await rpc('complete_calendar_sync', { p_booking_id: item.booking_id, p_queued_at: item.queued_at, p_error: null })
              summary.synced += 1
            } catch (failure) {
              const message = failure instanceof GoogleError || failure instanceof NeedsReconnect ? failure.message : 'The copy could not be made. It will be tried again.'
              await rpc('complete_calendar_sync', { p_booking_id: item.booking_id, p_queued_at: item.queued_at, p_error: message })
              if (failure instanceof NeedsReconnect) throw failure
              summary.failed += 1
              lastError = message
            }
          }
        }
      } catch (failure) {
        if (failure instanceof NeedsReconnect) {
          // Google will not take the saved sign-in: stop here, keep the reason for the Admin's screen, and try nothing more until connected again.
          await rpc('calendar_forget_connection', { p_status: 'needs_reconnect', p_error: failure.message })
          return { ...summary, stopped: 'needs reconnect' }
        }
        lastError = failure instanceof GoogleError ? failure.message : 'The copy could not be made. It will be tried again.'
        summary.failed += 1
      }
      const stamp = new Date(now()).toISOString()
      if (lastError) await note({ last_error: lastError, last_error_at: stamp, ...(summary.synced ? { last_success_at: stamp } : {}) })
      else if (summary.synced) await note({ last_success_at: stamp, last_error: null, last_error_at: null })
      return summary
    },
  }
}
