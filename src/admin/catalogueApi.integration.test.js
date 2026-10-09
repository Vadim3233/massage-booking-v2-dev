import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { paymentReviewFixture } from '../../tests/paymentReviewFixture.js'
import { createBookingApi } from '../client/booking/bookingApi.js'
import { createCatalogueApi } from './catalogueApi.js'

let f, api, tag
const prices = (...pairs) => [60, 90, 120].map(duration_minutes => { const found = pairs.find(([minutes]) => minutes === duration_minutes); return { duration_minutes, offered: Boolean(found), price: found ? String(found[1]) : '' } })
beforeEach(async () => { f = await paymentReviewFixture(); api = createCatalogueApi(f.client); tag = `E2E ${crypto.randomUUID().slice(0, 8)}` }, 30000)
afterEach(async () => {
  await f.admin.from('services').delete().like('name', 'E2E %')
  await f.admin.from('service_areas').delete().like('name', 'E2E %')
  await f.admin.from('enhancements').delete().like('name', 'E2E %')
  await f?.cleanup()
}, 30000)
const publicNames = async table => (await f.publicClient.from(table).select('name').eq('active', true)).data.map(row => row.name)

describe('settings against local Supabase', () => {
  it('adds a treatment with prices, which clients then see, and hiding it removes it from their choices', async () => {
    await f.authorize()
    await api.createService({ name: tag, short_description: 'Warm stones', active: true }, prices([60, 95], [90, 130]), 500)
    const row = (await api.services()).find(item => item.name === tag)
    expect(row.slug).toMatch(/^e2e-/)
    expect(row.service_duration_prices.filter(price => price.active).map(price => [price.duration_minutes, Number(price.price_gbp)]).sort()).toEqual([[60, 95], [90, 130]])
    expect(await publicNames('services')).toContain(tag)
    const clientView = await createBookingApi(f.publicClient).catalogue()
    expect(clientView.prices.filter(price => price.service_id === row.id).map(price => price.duration_minutes).sort()).toEqual([60, 90])
    await api.saveService({ ...row, active: false }, prices([60, 95], [90, 130]))
    expect(await publicNames('services')).not.toContain(tag)
  })

  it('changes a price and switches a length off without touching other lengths', async () => {
    await f.authorize()
    await api.createService({ name: tag, active: true }, prices([60, 90], [90, 125], [120, 170]), 510)
    const row = (await api.services()).find(item => item.name === tag)
    await api.saveService(row, prices([60, 100], [90, 125]))
    const saved = (await api.services()).find(item => item.name === tag).service_duration_prices
    expect(Object.fromEntries(saved.map(price => [price.duration_minutes, [Number(price.price_gbp), price.active]]))).toEqual({ 60: [100, true], 90: [125, true], 120: [0, false] })
  })

  it('keeps names unique and moves items up and down', async () => {
    await f.authorize()
    await api.createService({ name: tag, active: true }, prices([60, 90]), 520)
    await api.createService({ name: tag, active: true }, prices([60, 90]), 530)
    const rows = (await api.services()).filter(item => item.name === tag)
    expect(new Set(rows.map(row => row.slug)).size).toBe(2)
    await api.swapServices(rows[0], rows[1])
    const after = (await api.services()).filter(item => item.name === tag)
    expect(after.map(row => row.id)).toEqual([rows[1].id, rows[0].id])
  })

  it('manages areas and extras, including fees clients are quoted', async () => {
    await f.authorize()
    await api.createArea({ name: tag, active: true, travel_surcharge_gbp: '5', congestion_fee_gbp: '18' }, 1000)
    const area = (await api.areas()).find(item => item.name === tag)
    expect(area).toMatchObject({ active: true })
    expect([Number(area.travel_surcharge_gbp), Number(area.congestion_fee_gbp)]).toEqual([5, 18])
    expect(await publicNames('service_areas')).toContain(tag)
    await api.saveArea({ ...area, active: false, travel_surcharge_gbp: '5.00', congestion_fee_gbp: '18.00' })
    expect(await publicNames('service_areas')).not.toContain(tag)
    await api.createExtra({ name: tag, description: 'Extra pressure', price_gbp: '15', duration_minutes: '0', active: true }, 1000)
    const extra = (await api.extras()).find(item => item.name === tag)
    expect(Number(extra.price_gbp)).toBe(15)
    await api.saveExtra({ ...extra, price_gbp: '12.50', active: true })
    expect(Number((await api.extras()).find(item => item.name === tag).price_gbp)).toBe(12.5)
  })

  it('refuses everyone who is not an Admin, without technical wording', async () => {
    await expect(api.createArea({ name: tag, active: true, travel_surcharge_gbp: '0', congestion_fee_gbp: '0' }, 1000)).rejects.toThrow('Could not save. Please check your connection and try again.')
    expect((await f.admin.from('service_areas').select('id').eq('name', tag)).data).toEqual([])
  })
})
