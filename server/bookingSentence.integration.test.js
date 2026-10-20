import { beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { localConfig } from '../tests/localSupabase.js'
import { MAX_PEOPLE, MAX_VISIT_MINUTES, peopleSentence } from '../src/booking/bookingWords.js'

// The emails' sentence is made in the database (people_sentence); the screens' in src/booking/bookingWords.js. They must read the same,
// word for word, for every booking that can be made: one to four people, each 60, 90 or 120 minutes, at most four hours.
let db
beforeAll(() => {
  const config = localConfig()
  db = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
})
function everyBooking() {
  const all = []
  const grow = durations => {
    if (durations.length) all.push(durations)
    if (durations.length === MAX_PEOPLE) return
    for (const minutes of [60, 90, 120]) if (durations.reduce((a, b) => a + b, 0) + minutes <= MAX_VISIT_MINUTES) grow([...durations, minutes])
  }
  grow([])
  return all
}

describe('the emails say the same sentence as the screens', () => {
  it('for every combination of people and lengths, for massages and other treatments', async () => {
    const cases = everyBooking()
    expect(cases.length).toBeGreaterThan(20)
    for (const noun of ['massage', 'session']) {
      for (const durations of cases) {
        const { data, error } = await db.rpc('people_sentence', { p_durations: durations, p_noun: noun })
        expect(error).toBeNull()
        expect(data, durations.join('+')).toBe(peopleSentence(durations, noun))
      }
    }
  })
})
