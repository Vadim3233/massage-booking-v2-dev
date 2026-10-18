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
  it('asks the database for the times of a day that has gone', async () => {
    const calls = []
    const api = createAdminNewBookingApi({ rpc: (name, args) => { calls.push([name, args]); return Promise.resolve({ data: { slots: [] }, error: null }) } })
    await api.pastTimes('2026-10-06', 90)
    expect(calls).toEqual([['admin_past_booking_times', { p_date: '2026-10-06', p_treatment_duration_minutes: 90 }]])
  })
})
