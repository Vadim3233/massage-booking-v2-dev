import { describe, expect, it } from 'vitest'
import { describeLine, linesByDay, mergeRepeats, storySummary } from './activityLine.js'
import { createActivityApi, lineFromAlert } from './activityApi.js'

const B = '0b6c7f5e-1111-4222-8333-444455556666'
const row = (overrides = {}) => ({
  id: crypto.randomUUID(), event_type: 'booking.created', at: '2026-11-16T07:41:00+00:00', actor: 'client', booking_id: B, client_id: 'c1',
  name: 'Sabri Dylan', booking_date: '2026-11-21', booking_start: 840, booking_minutes: 90, booking_total: 188, payload: {}, sent: null, ...overrides })

describe('a line of the record', () => {
  it('shows a move as old time crossed out and new time, and who did it', () => {
    const line = describeLine(row({ event_type: 'booking.rescheduled', payload: { from_date: '2026-11-20', from_start_minutes: 600, to_date: '2026-11-21', to_start_minutes: 840 } }))
    expect(line.what).toBe('Moved their appointment')
    expect(line.changes).toEqual([{ key: 'time', from: 'Fri 20 Nov 10:00', to: 'Sat 21 Nov 14:00' }])
    expect(line.actorLabel).toBe('Client')
    // The day is already in the change, so it is not said twice.
    expect(line.who).toBe('Sabri Dylan')
  })
  it('says "client asked" when Vadim moved it for the client, and "late" inside the free window', () => {
    const line = describeLine(row({ event_type: 'booking.rescheduled', actor: 'admin', late: true, payload: { initiated_by: 'client', from_date: '2026-11-17', from_start_minutes: 600, to_date: '2026-11-18', to_start_minutes: 600 } }))
    expect(line.what).toBe('Moved')
    expect(line.actorLabel).toBe('You')
    expect(line.tags.map(tag => tag.text)).toEqual(['client asked', 'late'])
    expect(line.tags.find(tag => tag.text === 'late').tone).toBe('late')
  })
  it('shows a changed booking with the old and new price, and what it was before', () => {
    const line = describeLine(row({ event_type: 'booking.services_changed', payload: { previous_total_gbp: 95, total_gbp: 125, previous_sessions: 'Deep tissue 60 min', from_date: '2026-11-21', from_start_minutes: 840, to_date: '2026-11-21', to_start_minutes: 840 } }))
    expect(line.changes).toEqual([{ key: 'price', from: '£95', to: '£125' }])
    expect(line.amount).toBe('£125')
    expect(line.before).toBe('Before: Deep tissue 60 min')
  })
  it('keeps the wording of an alert a client raised, gold until read', () => {
    const line = describeLine(row({ event_type: 'booking.transfer_declared', alert_id: 'a1', alert_title: 'Sabri Dylan says the transfer is made', alert_body: 'Sabri Dylan: Sat 21 Nov at 14:00, £188.00.' }))
    expect(line.what).toBe('Transfer made')
    expect(line.unread).toBe(true)
    expect(describeLine(row({ alert_id: 'a1', alert_title: 'x', alert_read_at: '2026-11-16T08:00:00Z' })).unread).toBe(false)
  })
  it('is quiet for what Vadim and the app did, with the right name for each', () => {
    const paid = describeLine(row({ event_type: 'booking.bank_transfer_received', actor: 'admin', payload: { amount_gbp: 125 } }))
    expect([paid.what, paid.amount, paid.alert, paid.actorLabel]).toEqual(['Marked paid', '£125', false, 'You'])
    const reminder = describeLine(row({ event_type: 'booking.reminder', actor: 'system', sent: [{ channel: 'email', status: 'failed' }] }))
    expect([reminder.what, reminder.actorLabel, reminder.amount]).toEqual(['Reminder sent', 'Automatic', ''])
    expect(reminder.tags).toEqual([{ text: 'not sent', tone: 'late' }])
  })
  it('names a booking made through the client\'s AI assistant, and contact changes old → new', () => {
    expect(describeLine(row({ via: 'ai' })).actorLabel).toBe('Client · via AI')
    const changed = describeLine(row({ event_type: 'client.details_changed', actor: 'admin', booking_id: null, booking_date: null, payload: { changes: { phone: { from: '07700 900000', to: '07700 900111' } } } }))
    expect(changed.changes).toEqual([{ key: 'phone', from: '07700 900000', to: '07700 900111' }])
    expect(changed.who).toBe('Sabri Dylan')
  })
  it('says a gift or booking was cancelled since, on the line that started it, and names Vadim\'s cancel', () => {
    const bought = describeLine(row({ event_type: 'gift.bought', actor: 'buyer', booking_id: null, payload: { gift_status: 'cancelled' } }))
    expect(bought.tags).toEqual([{ text: 'cancelled since' }])
    expect(describeLine(row({ booking_status: 'cancelled' })).tags).toEqual([{ text: 'cancelled since' }])
    expect(describeLine(row({ event_type: 'booking.rescheduled', booking_status: 'cancelled' })).tags).toEqual([])
    const cancelled = describeLine(row({ event_type: 'gift.cancelled', actor: 'admin', booking_id: null }))
    expect([cancelled.what, cancelled.actorLabel]).toEqual(['Gift voucher cancelled', 'You'])
  })
  it('still shows something it does not know, under a plain name', () => {
    expect(describeLine(row({ event_type: 'booking.something_new' })).what).toBe('Something new')
  })
})

describe('quick repeat changes', () => {
  const move = (at, from, to, overrides = {}) => row({ event_type: 'booking.rescheduled', at, payload: { from_date: '2026-11-20', from_start_minutes: from, to_date: '2026-11-20', to_start_minutes: to }, ...overrides })
  it('read as one line within 10 minutes, from the first old time to the last new one', () => {
    const items = mergeRepeats([move('2026-11-16T07:48:00Z', 660, 720), move('2026-11-16T07:44:00Z', 630, 660), move('2026-11-16T07:41:00Z', 600, 630)])
    expect(items).toHaveLength(1)
    expect(items[0].line.times).toBe(3)
    expect(items[0].line.changes).toEqual([{ key: 'time', from: 'Fri 20 Nov 10:00', to: 'Fri 20 Nov 12:00' }])
  })
  it('stay separate when far apart, by someone else, or on another booking', () => {
    expect(mergeRepeats([move('2026-11-16T09:00:00Z', 660, 720), move('2026-11-16T07:41:00Z', 600, 630)])).toHaveLength(2)
    expect(mergeRepeats([move('2026-11-16T07:44:00Z', 660, 720, { actor: 'admin' }), move('2026-11-16T07:41:00Z', 600, 630)])).toHaveLength(2)
    expect(mergeRepeats([move('2026-11-16T07:44:00Z', 660, 720, { booking_id: 'other' }), move('2026-11-16T07:41:00Z', 600, 630)])).toHaveLength(2)
  })
  it('keep every unread alert of the group, so opening it reads them all', () => {
    const items = mergeRepeats([move('2026-11-16T07:44:00Z', 660, 720, { alert_id: 'a2' }), move('2026-11-16T07:41:00Z', 600, 630, { alert_id: 'a1' })])
    expect(items[0].unreadIds).toEqual(['a2', 'a1'])
  })
})

describe('days and summaries', () => {
  it('puts lines under their London day, newest first, counting the new ones', () => {
    const items = mergeRepeats([row({ at: '2026-11-16T07:41:00Z', alert_id: 'a' }), row({ at: '2026-11-15T23:30:00Z' }), row({ at: '2026-11-14T10:00:00Z' })])
    const days = linesByDay(items, '2026-11-16')
    // 23:30 UTC on 15 Nov is still 15 Nov in London in winter.
    expect(days.map(day => [day.name, day.items.length, day.unread])).toEqual([['Today', 1, 1], ['Yesterday', 1, 0], ['Sat 14 Nov', 1, 0]])
  })
  it('sums up a booking\'s story', () => {
    expect(storySummary([row(), row({ event_type: 'booking.rescheduled' }), row({ event_type: 'booking.rescheduled' })])).toBe('3 things · moved 2×')
    expect(storySummary([row()])).toBe('1 thing')
  })
})

describe('reading the record', () => {
  const client = results => ({ rpc: async name => results[name] || { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } } })
  it('falls back to the alerts as before when the database update is not applied yet', async () => {
    const alerts = { list: async () => [{ id: 'a1', title: 'Sabri Dylan cancelled', body: '', link_path: `/admin/bookings/${B}`, read_at: null, created_at: '2026-11-16T07:00:00Z' }], markRead: async () => null }
    const api = createActivityApi(client({}), alerts, { history: async () => [] })
    const result = await api.list({ filter: 'new' })
    expect(result.full).toBe(false)
    expect(result.rows).toEqual([lineFromAlert((await alerts.list())[0])])
    expect(result.rows[0].booking_id).toBe(B)
    expect((await api.list({ before: { at: 'x', id: 'y' } })).rows).toEqual([])
  })
  it('falls back to the old status and move history for a booking', async () => {
    const api = createActivityApi(client({}), { list: async () => [] }, { history: async () => [{ kind: 'schedule', from_date: '2026-11-20', from_start_minutes: 600, to_date: '2026-11-21', to_start_minutes: 840, actor_type: 'admin', occurred_at: 'x' }] })
    const [line] = await api.booking(B)
    expect(describeLine(line).changes).toEqual([{ key: 'time', from: 'Fri 20 Nov 10:00', to: 'Sat 21 Nov 14:00' }])
  })
  it('passes the filter, search and where to continue from', async () => {
    let args
    const api = createActivityApi({ rpc: async (name, value) => { args = [name, value]; return { data: [], error: null } } }, { list: async () => [] }, {})
    expect(await api.list({ filter: 'money', search: 'sab', before: { at: 't', id: 'i' }, limit: 50 })).toEqual({ rows: [], full: true })
    expect(args).toEqual(['admin_activity_list', { p_filter: 'money', p_search: 'sab', p_before_at: 't', p_before_id: 'i', p_limit: 50 }])
  })
  it('says plainly when the record cannot be read for another reason', async () => {
    const api = createActivityApi({ rpc: async () => ({ data: null, error: { code: '500', message: 'boom' } }) }, { list: async () => [] }, {})
    await expect(api.list()).rejects.toThrow('Could not load your alerts. Please retry.')
  })
})

describe('merging changes of different things', () => {
  it('keeps each thing with its own old and new value', () => {
    const detail = (at, changes) => ({ id: at, event_type: 'client.details_changed', at, actor: 'client', booking_id: null, client_id: 'c1', name: 'Ann Lee', payload: { changes } })
    const [item] = mergeRepeats([detail('2026-11-16T10:05:00Z', { phone: { from: '0700', to: '0799' } }), detail('2026-11-16T10:00:00Z', { name: { from: 'Ann Lea', to: 'Ann Lee' } })])
    expect(item.line.changes).toEqual([{ key: 'name', from: 'Ann Lea', to: 'Ann Lee' }, { key: 'phone', from: '0700', to: '0799' }])
  })
  it('does not stretch a group past 10 minutes from its newest change', () => {
    const move = at => row({ id: at, event_type: 'booking.rescheduled', at, payload: { from_date: '2026-11-20', from_start_minutes: 600, to_date: '2026-11-20', to_start_minutes: 660 } })
    expect(mergeRepeats([move('2026-11-16T10:18:00Z'), move('2026-11-16T10:09:00Z'), move('2026-11-16T10:00:00Z')]).map(item => item.rows.length)).toEqual([2, 1])
  })
})
