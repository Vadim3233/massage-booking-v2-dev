import { describe, expect, it } from 'vitest'
import { planWeeklySummary } from './weeklySummary.js'

function fakeClient(due) {
  const calls = []
  return {
    calls,
    rpc: async (name, args) => {
      calls.push([name, args])
      if (name === 'weekly_summary_due') return due
      return { data: true, error: null }
    },
  }
}
const visits = []
for (let i = 0; i < 12; i += 1) visits.push({ date: `2026-10-${String(5 + i * 2).padStart(2, '0')}`, start_minutes: 600, net_gbp: 90 })

describe('the Monday "Your week" message', () => {
  it('does nothing when it is not due or the database is not updated', async () => {
    for (const due of [{ data: null, error: null }, { data: null, error: { code: 'PGRST202' } }]) {
      const client = fakeClient(due)
      expect(await planWeeklySummary({ client })).toEqual({ due: false })
      expect(client.calls).toHaveLength(1)
    }
  })
  it('writes the text and queues it once for the week', async () => {
    const days = [{ date: '2026-11-03', open: 480, booked: 120 }, { date: '2026-11-07', open: 480, booked: 480 }]
    const client = fakeClient({ data: { today: '2026-11-16', visits, days, wanted: [], regulars: [] }, error: null })
    expect(await planWeeklySummary({ client })).toEqual({ due: true, queued: true })
    const [name, args] = client.calls[1]
    expect(name).toBe('queue_weekly_summary')
    expect(args.p_week).toBe('2026-11-16')
    expect(args.p_body).toMatch(/^Your week\n/)
    expect(args.p_body).toMatch(/Last 4 weeks: 63% of your working hours were booked\./)
  })
})
