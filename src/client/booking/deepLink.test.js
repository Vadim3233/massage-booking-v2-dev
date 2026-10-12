import { describe, expect, it } from 'vitest'
import { bookingLink, presetFromSearch, stepForPreset } from './deepLink.js'

const catalogue = {
  areas: [{ id: 'a1', name: 'Chelsea' }, { id: 'a2', name: 'Hammersmith & Fulham' }],
  services: [{ id: 's1', name: 'Massage' }, { id: 's2', name: 'Assisted Stretching' }],
  prices: [{ service_id: 's1', duration_minutes: 60 }, { service_id: 's1', duration_minutes: 90 }, { service_id: 's2', duration_minutes: 60 }],
}

describe('booking links', () => {
  it('finds the area, treatment and length by the names people would type', () => {
    expect(presetFromSearch('?area=chelsea&treatment=massage&minutes=90', catalogue)).toEqual({ areaId: 'a1', serviceId: 's1', minutes: 90 })
    expect(presetFromSearch('?area=Hammersmith-Fulham&treatment=assisted+stretching&minutes=60', catalogue)).toEqual({ areaId: 'a2', serviceId: 's2', minutes: 60 })
  })
  it('carries a link as far as it is understood', () => {
    expect(stepForPreset(presetFromSearch('?area=chelsea', catalogue))).toBe(1)
    expect(stepForPreset(presetFromSearch('?area=chelsea&treatment=massage', catalogue))).toBe(2)
    expect(stepForPreset(presetFromSearch('?area=chelsea&treatment=massage&minutes=60', catalogue))).toBe(3)
  })
  it('ignores a length that treatment is not sold in, and anything it does not know', () => {
    expect(presetFromSearch('?area=chelsea&treatment=assisted-stretching&minutes=120', catalogue)).toEqual({ areaId: 'a1', serviceId: 's2' })
    expect(presetFromSearch('?area=nowhere&treatment=massage', catalogue)).toEqual({ serviceId: 's1' })
    expect(presetFromSearch('?area=nowhere&treatment=nothing', catalogue)).toBeNull()
    expect(presetFromSearch('', catalogue)).toBeNull()
    expect(presetFromSearch('?minutes=60', catalogue)).toBeNull()
  })
  it('does not skip ahead without an area, since the area comes first', () => {
    expect(stepForPreset(presetFromSearch('?treatment=massage&minutes=60', catalogue))).toBe(0)
  })
})

describe('the link Vad sends', () => {
  it('is the plain booking page, or a page that starts part-way through', () => {
    expect(bookingLink('https://booking.example.test')).toBe('https://booking.example.test/')
    expect(bookingLink('https://booking.example.test', { area: 'Chelsea' })).toBe('https://booking.example.test/?area=chelsea')
    expect(bookingLink('https://booking.example.test', { area: 'Chelsea', treatment: 'Assisted Stretching', minutes: 90 })).toBe('https://booking.example.test/?area=chelsea&treatment=assisted-stretching&minutes=90')
  })
  it('leaves out a length that has no treatment and area to go with it', () => {
    expect(bookingLink('https://booking.example.test', { treatment: 'Massage', minutes: 60 })).toBe('https://booking.example.test/?treatment=massage')
    expect(bookingLink('https://booking.example.test', { area: 'Chelsea', treatment: 'Massage' })).toBe('https://booking.example.test/?area=chelsea&treatment=massage')
  })
  it('is read back by the booking page as the same area, treatment and length', () => {
    const link = new URL(bookingLink('https://booking.example.test', { area: 'Hammersmith & Fulham', treatment: 'Assisted Stretching', minutes: 60 }))
    expect(presetFromSearch(link.search, catalogue)).toEqual({ areaId: 'a2', serviceId: 's2', minutes: 60 })
  })
})
