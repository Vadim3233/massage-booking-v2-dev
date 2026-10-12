// "Book your usual": the area, treatment and length of the last booking made on this phone, offered again next time.
export const usualKey = 'vad-v2-usual-v1'

export function rememberUsual(storage, draft) {
  if (!draft.areaId || !draft.serviceId || !draft.sessions?.length) return false
  try {
    storage.setItem(usualKey, JSON.stringify({ version: 1, areaId: draft.areaId, serviceId: draft.serviceId, durations: draft.sessions.map(session => session.duration_minutes) }))
    return true
  } catch { return false }
}

// Only offered while it is still bookable: the area and treatment must still exist, and each length must still have a price.
export function readUsual(storage, catalogue) {
  let saved
  try { saved = JSON.parse(storage.getItem(usualKey)) } catch { return null }
  if (saved?.version !== 1 || !Array.isArray(saved.durations) || !saved.durations.length) return null
  const area = catalogue.areas.find(item => item.id === saved.areaId)
  const service = catalogue.services.find(item => item.id === saved.serviceId)
  if (!area || !service) return null
  const priced = catalogue.prices.filter(price => price.service_id === service.id).map(price => price.duration_minutes)
  if (!saved.durations.every(minutes => priced.includes(minutes)) || saved.durations.reduce((sum, minutes) => sum + minutes, 0) > 240) return null
  return { areaId: area.id, serviceId: service.id, durations: saved.durations, areaName: area.name, serviceName: service.name }
}

export const usualLabel = usual => `${usual.serviceName} · ${usual.durations.map(minutes => `${minutes} min`).join(' + ')} · ${usual.areaName}`
