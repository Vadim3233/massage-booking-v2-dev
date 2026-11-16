import { expect, it } from 'vitest'
import { groupByClient, howLongAgo } from './reviewClients.js'

const make = (id, client, date, start, price, kind = 'needs', extra = null) => ({ id, client_id: client, date, start_minutes: start, total_gbp: price, balance_due_gbp: extra, kind })
const rules = { needsYou: b => b.kind === 'needs', putOff: b => b.kind === 'later', isExtra: b => b.balance_due_gbp != null }

it('puts each client in one card, the client waiting longest first, with what is owed now', () => {
  const { needs, reminded, waiting } = groupByClient([
    make('d1', 'dan', '2026-11-15', 990, '180.00'),
    make('r3', 'rich', '2026-11-15', 1170, '193.00'),
    make('r1', 'rich', '2026-10-17', 720, '170.00'),
    make('r2', 'rich', '2026-10-23', 840, '170.00'),
  ], rules)
  expect(needs.map(g => [g.key, g.items.map(b => b.id), g.owed, g.oldest])).toEqual([
    ['client:rich', ['r1', 'r2', 'r3'], 533, '2026-10-17'],
    ['client:dan', ['d1'], 180, '2026-11-15'],
  ])
  expect(reminded).toEqual([]); expect(waiting).toEqual([])
})
it('keeps a client in Needs you while anything needs the Admin, counting only that, with put-off items after it', () => {
  const { needs, reminded } = groupByClient([make('a', 'c', '2026-10-01', 600, '90.00', 'later'), make('b', 'c', '2026-10-05', 600, '120.00')], rules)
  expect(reminded).toEqual([])
  expect(needs[0]).toMatchObject({ owed: 120, oldest: '2026-10-05' })
  expect(needs[0].items.map(b => b.id)).toEqual(['b', 'a'])
})
it('moves a client whose items are all put off to Reminder set, and a client with nothing to do yet to Waiting', () => {
  const { needs, reminded, waiting } = groupByClient([make('a', 'c', '2026-10-01', 600, '90.00', 'later'), make('w', 'x', '2026-12-01', 600, '90.00', 'wait')], rules)
  expect(needs).toEqual([])
  expect(reminded.map(g => [g.key, g.owed])).toEqual([['client:c', 90]])
  expect(waiting.map(g => g.key)).toEqual(['client:x'])
})
it('counts only the extra on a paid booking, and never merges bookings without a client', () => {
  const { needs } = groupByClient([make('e', 'c', '2026-11-01', 600, '90.00', 'needs', '45.00'), make('n1', null, '2026-11-02', 600, '90.00'), make('n2', null, '2026-11-03', 600, '90.00')], rules)
  expect(needs.map(g => [g.key, g.owed])).toEqual([['client:c', 45], ['booking:n1', 90], ['booking:n2', 90]])
})
it('says how long ago a day was', () => {
  expect(howLongAgo('2026-11-16', '2026-11-16')).toBe('today')
  expect(howLongAgo('2026-11-15', '2026-11-16')).toBe('yesterday')
  expect(howLongAgo('2026-10-17', '2026-11-16')).toBe('30 days ago')
  expect(howLongAgo('2026-11-21', '2026-11-16')).toBe('Sat 21 Nov')
})
