import { beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { localConfig } from '../tests/localSupabase.js'
import { MAX_PEOPLE, MAX_VISIT_MINUTES, optionTotal } from '../src/booking/bookingWords.js'

// The booking screen offers as many people and minutes as src/booking/bookingWords.js says; the database's quote is what really decides.
// This checks against local Supabase that the two agree, and that an option's price is the database's price for it.
let db, area, service, prices
beforeAll(async () => {
  const config = localConfig()
  db = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const catalogue = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const priced = (await catalogue.from('service_duration_prices').select('service_id,duration_minutes,price_gbp,services!inner(active)').eq('active', true).eq('services.active', true)).data
  service = priced.find(row => row.duration_minutes === 60 && priced.some(other => other.service_id === row.service_id && other.duration_minutes === 120)).service_id
  prices = priced.filter(row => row.service_id === service)
  area = (await catalogue.from('service_areas').select('id,travel_surcharge_gbp,congestion_fee_gbp').eq('active', true).limit(1).single()).data
})
const quote = durations => db.rpc('quote_client_booking', {
  p_service_area_id: area.id, p_enhancement_ids: [],
  p_sessions: durations.map(minutes => ({ service_id: service, duration_minutes: minutes, recipient_name: durations.length > 1 ? 'Guest' : '', preference_ids: [] })),
})

describe('the booking limits agree with the database', () => {
  it('accepts as many people as the screen offers, and refuses one more', async () => {
    expect((await quote(Array(MAX_PEOPLE).fill(60))).error).toBeNull()
    expect((await quote(Array(MAX_PEOPLE + 1).fill(60))).error?.message).toMatch(/between one and four sessions/)
  })
  it('accepts a visit as long as the screen allows, and refuses a longer one', async () => {
    expect((await quote([120, 120])).error).toBeNull()
    expect(MAX_VISIT_MINUTES).toBe(240)
    expect((await quote([120, 90, 60])).error?.message).toMatch(/240 minutes/)
  })
  it('prices an option exactly as the database quotes it', async () => {
    for (const durations of [[60], [120], [60, 60], [60, 120]]) {
      const { data, error } = await quote(durations)
      expect(error).toBeNull()
      expect(Number((Array.isArray(data) ? data[0] : data).total_gbp)).toBe(optionTotal(prices, area, durations))
    }
  })
})
