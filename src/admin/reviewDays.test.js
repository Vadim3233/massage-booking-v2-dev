import { expect, it } from 'vitest'
import { groupByAppointmentDay } from './reviewDays.js'

const make = (id, date, start, price, needs) => ({ id, date, start_minutes: start, total_gbp: price, needs })
const needsYou = booking => booking.needs

it('puts each payment under the day of its appointment, soonest day first, with those that need the Admin first within a day', () => {
  const days = groupByAppointmentDay([
    make('c', '2026-10-15', 660, '90.00', false), make('b', '2026-10-14', 870, '90.00', true), make('a', '2026-10-13', 990, '90.00', true),
    make('d', '2026-10-15', 900, '125.00', true), make('e', '2026-10-14', 600, '90.00', false),
  ], needsYou, '2026-10-13')
  expect(days.map(day => [day.date, day.name, day.items.map(item => item.id), day.needs, day.owed])).toEqual([
    ['2026-10-13', 'Today', ['a'], 1, 90],
    ['2026-10-14', 'Tomorrow', ['b', 'e'], 1, 90],
    ['2026-10-15', 'Thu 15 Oct', ['d', 'c'], 1, 125],
  ])
})
it('counts nothing as owed for a day where every payment is waiting for the client, and copes with an empty list', () => {
  const [day] = groupByAppointmentDay([make('a', '2026-10-14', 600, '90.00', false)], needsYou, '2026-10-13')
  expect(day).toMatchObject({ needs: 0, owed: 0 })
  expect(groupByAppointmentDay([], needsYou, '2026-10-13')).toEqual([])
})
