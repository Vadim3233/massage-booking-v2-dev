import { describe, expect, it } from 'vitest'
import { emptyAdminDraft } from './adminBookingDraft.js'
import { bookingRequest } from './newBookingApi.js'

const draft = patch => ({
  ...emptyAdminDraft('2026-10-19'), client: { id: 'c1', first_name: 'Amelia', last_name: 'Hart' }, areaId: 'a1', serviceId: 's1',
  details: { savedAddressId: 'addr1' }, start: 960, ...patch,
})

describe('the request for a new booking', () => {
  it('asks for "any time" only when the time was chosen from outside the usual ones', () => {
    expect(bookingRequest(draft({ anyTime: true }))).toMatchObject({ any_time: true, start_minutes: 960, date: '2026-10-19' })
    expect(bookingRequest(draft({ anyTime: false }))).not.toHaveProperty('any_time')
    expect(bookingRequest(draft())).not.toHaveProperty('any_time')
  })
  it('starts a draft with no unusual time chosen', () => {
    expect(emptyAdminDraft('2026-10-19')).toMatchObject({ start: null, anyTime: false, anyTimeNotes: [] })
  })
})
