import { describe, expect, it } from 'vitest'
import { canAddPerson, lengthFits, moneyLines, newPerson, peopleChanged, peopleFromBooking, personPrice, sessionsPayload, totalMinutes } from './bookingChange.js'

const booking = {
  booking_sessions: [
    { id: 's2', position: 2, service_id: 'deep', duration_minutes: 60, recipient_name: 'Sam', service_name_snapshot: 'Deep tissue', unit_price_gbp: '80.00' },
    { id: 's1', position: 1, service_id: 'swed', duration_minutes: 60, recipient_name: null, service_name_snapshot: 'Swedish', unit_price_gbp: '75.00' },
  ],
}
const prices = [{ service_id: 'swed', duration_minutes: 60, price_gbp: '85.00' }, { service_id: 'swed', duration_minutes: 90, price_gbp: '110.00' }]
const plan = (overrides = {}) => ({ total_gbp: 160, previous_total_gbp: 160, refund_due_gbp: 0, previous_refund_due_gbp: 0, balance_due_gbp: 0, previous_balance_due_gbp: 0,
  price_kept: false, held: false, payment_method: 'bank_transfer', free_cancellation_hours: 24, ...overrides })

describe('changing a booking', () => {
  it('turns the sessions into people in order, and back into what the database is sent', () => {
    const people = peopleFromBooking(booking)
    expect(people.map(person => person.id)).toEqual(['s1', 's2'])
    expect(people[0].recipient_name).toBe('')
    expect(sessionsPayload([...people, newPerson(people)])).toEqual([
      { id: 's1', service_id: 'swed', duration_minutes: 60, recipient_name: null },
      { id: 's2', service_id: 'deep', duration_minutes: 60, recipient_name: 'Sam' },
      { service_id: 'swed', duration_minutes: 60, recipient_name: null },
    ])
  })
  it('notices any change to the people, but not spaces around a name', () => {
    const people = peopleFromBooking(booking)
    expect(peopleChanged(booking, people)).toBe(false)
    expect(peopleChanged(booking, people.map((person, i) => (i === 1 ? { ...person, recipient_name: ' Sam ' } : person)))).toBe(false)
    expect(peopleChanged(booking, people.slice(0, 1))).toBe(true)
    expect(peopleChanged(booking, people.map((person, i) => (i === 0 ? { ...person, duration_minutes: 90 } : person)))).toBe(true)
  })
  it('keeps a booked price for an unchanged person and uses today\'s prices for a change', () => {
    const [first] = peopleFromBooking(booking)
    expect(personPrice(booking, first, prices)).toBe(75)
    expect(personPrice(booking, { ...first, duration_minutes: 90 }, prices)).toBe(110)
    expect(personPrice(booking, { ...first, duration_minutes: 120 }, prices)).toBeNull()
    expect(personPrice(booking, { id: null, service_id: 'swed', duration_minutes: 60 }, prices)).toBe(85)
  })
  it('keeps a visit within four people and four hours', () => {
    const two = peopleFromBooking(booking)
    expect(totalMinutes(two)).toBe(120)
    expect(canAddPerson(two)).toBe(true)
    expect(lengthFits(two, 0, 120)).toBe(true)
    const long = two.map(person => ({ ...person, duration_minutes: 120 }))
    expect(canAddPerson(long)).toBe(false)
    expect(lengthFits(long, 0, 120)).toBe(true)
    expect(lengthFits([...two, newPerson(two)], 0, 120)).toBe(true)
    expect(lengthFits([...long, newPerson(long)].slice(0, 2), 1, 120)).toBe(true)
  })
})

describe('what the change means for the money, in words', () => {
  it('says a new price and what is now asked for when nothing is paid', () => {
    expect(moneyLines(plan({ total_gbp: 80 }), 'client')).toEqual(['New price £80.00 (was £160.00).', 'The amount to pay is now £80.00.'])
  })
  it('says a refund is on its way after a paid booking is made shorter', () => {
    expect(moneyLines(plan({ total_gbp: 80, held: true, refund_due_gbp: 80 }), 'admin')).toEqual(['New price £80.00 (was £160.00).',
      'Refund to send: £80.00. It shows on the booking until you press Record refund sent.'])
  })
  it('asks a paying client for the extra, by transfer or in cash', () => {
    expect(moneyLines(plan({ total_gbp: 200, held: true, balance_due_gbp: 40 }), 'client')[1]).toBe('£40.00 more to pay by bank transfer. The details are in the email I send you.')
    expect(moneyLines(plan({ total_gbp: 200, held: true, balance_due_gbp: 40, payment_method: 'cash' }), 'admin')[1]).toBe('The client pays the extra £40.00 in cash at the appointment.')
  })
  it('keeps the price inside the free-cancellation window', () => {
    expect(moneyLines(plan({ price_kept: true, held: true }), 'client')).toEqual(['This is within 24 hours of your appointment, so the price stays £160.00 and there is no refund for this change.'])
    expect(moneyLines(plan({ price_kept: true, payment_method: 'cash' }), 'client')[1]).toBe('Please have the full £160.00 ready in cash at your appointment.')
  })
})
