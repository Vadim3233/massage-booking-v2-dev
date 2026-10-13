// A link such as /?area=chelsea&treatment=massage&minutes=60 opens the booking part-way through, so Vad can put it in a message or on her website.
export const slug = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

export function presetFromSearch(search, catalogue) {
  const params = new URLSearchParams(search)
  const wanted = key => slug(params.get(key))
  const area = wanted('area') && catalogue.areas.find(item => slug(item.name) === wanted('area'))
  const service = wanted('treatment') && catalogue.services.find(item => slug(item.name) === wanted('treatment'))
  if (!area && !service) return null
  const minutes = Number(params.get('minutes'))
  const priced = service && catalogue.prices.some(price => price.service_id === service.id && price.duration_minutes === minutes)
  return {
    ...(area ? { areaId: area.id } : {}),
    ...(service ? { serviceId: service.id } : {}),
    ...(area && service && priced ? { minutes } : {}),
  }
}

// How far such a link can carry someone: the area, then the treatment, then the length, which leads to choosing a time.
export const stepForPreset = preset => (preset.areaId ? (preset.serviceId ? (preset.minutes ? 3 : 2) : 1) : 0)

// The address to send to a client: the booking page itself, or part-way through it for one area, treatment and length.
export function bookingLink(origin, { area, treatment, minutes } = {}) {
  const params = new URLSearchParams()
  if (area) params.set('area', slug(area))
  if (treatment) params.set('treatment', slug(treatment))
  if (area && treatment && minutes) params.set('minutes', String(minutes))
  const query = params.toString()
  return `${origin}/${query ? `?${query}` : ''}`
}
