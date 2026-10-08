import { supabase } from '../lib/supabase.js'

export const DURATIONS = [60, 90, 120]
const GENERIC = 'Could not save. Please check your connection and try again.'

export const slugify = text => String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item'

// Money as typed: pounds with up to two decimals.
export function parsePrice(text) {
  const value = String(text ?? '').trim().replace(/^£/, '')
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(value)) return null
  return Number(value)
}
export const priceText = value => value == null ? '' : Number(value).toFixed(2)

export function validateService(service, prices) {
  if (!service.name.trim()) return 'Give the treatment a name.'
  if (service.name.trim().length > 120) return 'Keep the name under 120 characters.'
  const offered = prices.filter(price => price.offered)
  for (const price of offered) if (parsePrice(price.price) === null) return `Enter a price for ${price.duration_minutes} minutes, for example 90 or 90.50.`
  if (service.active && !offered.length) return 'A shown treatment needs at least one length with a price. Hide it instead, or offer a length.'
  return ''
}
export function validateArea(area) {
  if (!area.name.trim()) return 'Give the area a name.'
  for (const [label, value] of [['travel surcharge', area.travel_surcharge_gbp], ['congestion charge', area.congestion_fee_gbp]]) if (parsePrice(value) === null) return `Enter the ${label}, or 0 for none.`
  return ''
}
export function validateExtra(extra) {
  if (!extra.name.trim()) return 'Give the extra a name.'
  if (parsePrice(extra.price_gbp) === null) return 'Enter the price, or 0 for none.'
  const minutes = Number(extra.duration_minutes)
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 120) return 'Extra time must be a whole number of minutes from 0 to 120.'
  return ''
}

export function createCatalogueApi(client) {
  async function run(request) {
    const { data, error } = await request
    if (error) throw new Error(GENERIC)
    return data
  }
  async function uniqueSlug(table, name) {
    const base = slugify(name)
    const taken = new Set((await run(client.from(table).select('slug').like('slug', `${base}%`))).map(row => row.slug))
    if (!taken.has(base)) return base
    for (let n = 2; n < 100; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
    throw new Error(GENERIC)
  }
  const priceRows = (serviceId, prices) => prices.map(price => ({ service_id: serviceId, duration_minutes: price.duration_minutes, price_gbp: price.offered ? parsePrice(price.price) : (parsePrice(price.price) ?? 0), active: Boolean(price.offered) }))
  // Swap the display positions of two neighbours; positions are spaced so a swap never collides.
  async function swap(table, a, b) {
    await run(client.from(table).update({ display_order: b.display_order }).eq('id', a.id))
    await run(client.from(table).update({ display_order: a.display_order }).eq('id', b.id))
  }
  return {
    services: () => run(client.from('services').select('id,slug,name,short_description,long_description,active,display_order,service_duration_prices(duration_minutes,price_gbp,active)').order('display_order').order('name')),
    async saveService(service, prices) {
      await run(client.from('services').update({ name: service.name.trim(), short_description: service.short_description?.trim() || null, long_description: service.long_description?.trim() || null, active: Boolean(service.active) }).eq('id', service.id))
      await run(client.from('service_duration_prices').upsert(priceRows(service.id, prices), { onConflict: 'service_id,duration_minutes' }))
    },
    async createService(service, prices, nextOrder) {
      const row = await run(client.from('services').insert({ slug: await uniqueSlug('services', service.name), name: service.name.trim(), short_description: service.short_description?.trim() || null, long_description: service.long_description?.trim() || null, active: Boolean(service.active), display_order: nextOrder }).select('id').single())
      try { await run(client.from('service_duration_prices').upsert(priceRows(row.id, prices), { onConflict: 'service_id,duration_minutes' })) }
      catch (failure) { await client.from('services').delete().eq('id', row.id); throw failure }
    },
    swapServices: (a, b) => swap('services', a, b),
    areas: () => run(client.from('service_areas').select('id,slug,name,active,travel_surcharge_gbp,congestion_fee_gbp,display_order').order('display_order').order('name')),
    saveArea: area => run(client.from('service_areas').update({ name: area.name.trim(), active: Boolean(area.active), travel_surcharge_gbp: parsePrice(area.travel_surcharge_gbp), congestion_fee_gbp: parsePrice(area.congestion_fee_gbp) }).eq('id', area.id)),
    async createArea(area, nextOrder) {
      return run(client.from('service_areas').insert({ slug: await uniqueSlug('service_areas', area.name), name: area.name.trim(), active: Boolean(area.active), travel_surcharge_gbp: parsePrice(area.travel_surcharge_gbp), congestion_fee_gbp: parsePrice(area.congestion_fee_gbp), display_order: nextOrder }))
    },
    swapAreas: (a, b) => swap('service_areas', a, b),
    extras: () => run(client.from('enhancements').select('id,slug,name,description,price_gbp,duration_minutes,active,display_order').order('display_order').order('name')),
    saveExtra: extra => run(client.from('enhancements').update({ name: extra.name.trim(), description: extra.description?.trim() || null, price_gbp: parsePrice(extra.price_gbp), duration_minutes: Number(extra.duration_minutes), active: Boolean(extra.active) }).eq('id', extra.id)),
    async createExtra(extra, nextOrder) {
      return run(client.from('enhancements').insert({ slug: await uniqueSlug('enhancements', extra.name), name: extra.name.trim(), description: extra.description?.trim() || null, price_gbp: parsePrice(extra.price_gbp), duration_minutes: Number(extra.duration_minutes), active: Boolean(extra.active), display_order: nextOrder }))
    },
    swapExtras: (a, b) => swap('enhancements', a, b),
  }
}
export const catalogueApi = createCatalogueApi(supabase)
