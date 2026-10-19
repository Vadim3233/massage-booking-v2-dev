import { describe, expect, it } from 'vitest'
import { emptyAdminDraft } from './adminBookingDraft.js'
import { shiftDate, today } from './calendarPresentation.js'
import { bookingRequest, createAdminNewBookingApi } from './newBookingApi.js'

// A day still to come, whatever day the tests run on (a fixed date would turn into a day that has gone).
const DAY = shiftDate(today(), 10)

const draft = patch => ({
  ...emptyAdminDraft(DAY), client: { id: 'c1', first_name: 'Amelia', last_name: 'Hart' }, areaId: 'a1', serviceId: 's1',
  details: { savedAddressId: 'addr1' }, start: 960, ...patch,
})

describe('the request for a new booking', () => {
  it('asks for "any time" only when the time was chosen from outside the usual ones', () => {
    expect(bookingRequest(draft({ anyTime: true }))).toMatchObject({ any_time: true, start_minutes: 960, date: DAY })
    expect(bookingRequest(draft({ anyTime: false }))).not.toHaveProperty('any_time')
    expect(bookingRequest(draft())).not.toHaveProperty('any_time')
  })
  it('sends a one-off address as one text with its way in, and no address when a saved one is chosen', () => {
    const typed = draft({ details: { savedAddressId: '', address: '  5 Typed Road\nLondon ', entry_instructions: ' Ring twice ' } })
    expect(bookingRequest(typed)).toMatchObject({ saved_address_id: null, address: { address: '5 Typed Road\nLondon', entry_instructions: 'Ring twice' } })
    expect(bookingRequest(draft({ details: { savedAddressId: '', address: '5 Typed Road', entry_instructions: '' } }))).toMatchObject({ address: { address: '5 Typed Road', entry_instructions: null } })
    expect(bookingRequest(draft({ details: { savedAddressId: 'addr1' } }))).toMatchObject({ saved_address_id: 'addr1', address: null })
  })
  it('starts a draft with no unusual time chosen', () => {
    expect(emptyAdminDraft(DAY)).toMatchObject({ start: null, anyTime: false, anyTimeNotes: [] })
  })
  it('says "past" only for an appointment that has already happened, and never together with "any time"', () => {
    expect(bookingRequest(draft({ past: true }))).toMatchObject({ past: true, start_minutes: 960, date: DAY })
    expect(bookingRequest(draft({ past: true }))).not.toHaveProperty('any_time')
    // Even a draft that somehow has both (the database refuses the pair) says only that it has already happened.
    expect(bookingRequest(draft({ past: true, anyTime: true }))).toMatchObject({ past: true })
    expect(bookingRequest(draft({ past: true, anyTime: true }))).not.toHaveProperty('any_time')
    expect(bookingRequest(draft({ past: false, anyTime: true }))).toMatchObject({ any_time: true })
    expect(bookingRequest(draft({ past: false }))).not.toHaveProperty('past')
    expect(bookingRequest(draft({ past: undefined }))).not.toHaveProperty('past')
  })
  it('makes a repeat with its pattern only when it is not simply every week', async () => {
    const calls = []
    const api = createAdminNewBookingApi({ rpc: (name, args) => { calls.push([name, args]); return Promise.resolve({ data: [{ series_id: 's1' }], error: null }) } })
    const request = { client_id: 'c1' }
    await api.createSeries(request, null, 'k1')
    await api.createSeries(request, '2027-06-01', 'k2', null)
    await api.createSeries(request, null, 'k3', { kind: 'weeks', every_weeks: 2 })
    await api.createSeries(request, null, 'k4', { kind: 'dates', dates: ['2027-03-11'] })
    expect(calls).toEqual([
      ['admin_create_series', { p_request: request, p_end_date: null, p_request_id: 'k1' }],
      ['admin_create_series', { p_request: request, p_end_date: '2027-06-01', p_request_id: 'k2' }],
      ['admin_create_series', { p_request: request, p_end_date: null, p_request_id: 'k3', p_pattern: { kind: 'weeks', every_weeks: 2 } }],
      ['admin_create_series', { p_request: request, p_end_date: null, p_request_id: 'k4', p_pattern: { kind: 'dates', dates: ['2027-03-11'] } }],
    ])
  })
  it('asks the database for the times of a day that has gone', async () => {
    const calls = []
    const api = createAdminNewBookingApi({ rpc: (name, args) => { calls.push([name, args]); return Promise.resolve({ data: { slots: [] }, error: null }) } })
    await api.pastTimes('2026-10-06', 90)
    expect(calls).toEqual([['admin_past_booking_times', { p_date: '2026-10-06', p_treatment_duration_minutes: 90 }]])
  })
  // A stand-in for the bookings table: the newest booking that is not cancelled, and the newest that is, for one client.
  function bookingsTable({ kept, cancelled }) {
    const reads = []
    return { reads, from: () => {
      const read = { filters: [] }
      reads.push(read)
      const query = {
        select: columns => { read.columns = columns; return query },
        eq: (column, value) => { read.filters.push(['eq', column, value]); return query },
        neq: (column, value) => { read.filters.push(['neq', column, value]); return query },
        order: () => query, limit: () => query,
        then: (resolve, reject) => Promise.resolve({ data: read.filters.some(([how]) => how === 'neq') ? kept : cancelled, error: null }).then(resolve, reject),
      }
      return query
    } }
  }
  it('suggests from the client\'s last booking that was not cancelled, and reads nothing more when there is one', async () => {
    const last = { service_area_id: 'a1', booking_sessions: [], booking_payments: { method: 'cash' } }
    const table = bookingsTable({ kept: [last], cancelled: [{ service_area_id: 'a2' }] })
    expect(await createAdminNewBookingApi(table).lastBooking('c1')).toEqual(last)
    expect(table.reads).toHaveLength(1)
    expect(table.reads[0].filters).toEqual([['eq', 'client_id', 'c1'], ['neq', 'booking_status', 'cancelled']])
  })
  it('suggests only the area of the last cancelled booking when every booking was cancelled, and nothing when there are none', async () => {
    const table = bookingsTable({ kept: [], cancelled: [{ service_area_id: 'a2' }] })
    expect(await createAdminNewBookingApi(table).lastBooking('c1')).toEqual({ service_area_id: 'a2' })
    expect(table.reads[1]).toEqual({ columns: 'service_area_id', filters: [['eq', 'client_id', 'c1'], ['eq', 'booking_status', 'cancelled']] })
    expect(await createAdminNewBookingApi(bookingsTable({ kept: [], cancelled: [] })).lastBooking('c1')).toBeNull()
  })
})
