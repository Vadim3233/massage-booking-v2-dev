import { expect, it } from 'vitest'
import { reanchored } from './agendaRange.js'

it('starts the list again from today when it was left open since an earlier day, keeping its length', () => {
  expect(reanchored({ start: '2026-10-12', end: '2026-11-12' }, '2026-10-12', '2026-10-14')).toEqual({ start: '2026-10-14', end: '2026-11-14' })
  expect(reanchored({ start: '2026-10-12', end: '2026-12-13' }, '2026-10-12', '2026-10-13')).toEqual({ start: '2026-10-13', end: '2026-12-14' })
})
it('leaves the list alone on the same day, when earlier days were opened up, and when nothing is shown yet', () => {
  const range = { start: '2026-10-12', end: '2026-11-12' }
  expect(reanchored(range, '2026-10-12', '2026-10-12')).toBe(range)
  expect(reanchored({ start: '2026-09-11', end: '2026-11-12' }, '2026-10-12', '2026-10-14')).toEqual({ start: '2026-09-11', end: '2026-11-12' })
  expect(reanchored(null, null, '2026-10-14')).toBeNull()
  expect(reanchored(range, null, '2026-10-14')).toBe(range)
})
