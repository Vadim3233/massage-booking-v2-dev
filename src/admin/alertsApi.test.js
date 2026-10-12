import { describe, expect, it } from 'vitest'
import { bookingIdFromLink, groupAlerts } from './alertsApi.js'

const A = '0b6c7f5e-1111-4222-8333-444455556666'
const B = '9d1e2f3a-aaaa-4bbb-8ccc-ddddeeeeffff'
const alert = (id, link, read = null) => ({ id, title: `Alert ${id}`, body: '', link_path: link, read_at: read, created_at: '2026-10-12T14:00:00Z' })

describe('alerts about the same booking', () => {
  it('become one card, newest first, with the older ones beneath it', () => {
    const groups = groupAlerts([alert(1, `/admin/bookings/${A}`), alert(2, `/admin/bookings/${B}`), alert(3, `/admin/bookings/${A}`)])
    expect(groups.map(group => group.head.id)).toEqual([1, 2])
    expect(groups[0].older.map(item => item.id)).toEqual([3])
    expect(groups[0].ids).toEqual([1, 3])
    expect(groups[1].older).toEqual([])
  })
  it('keep the unread ones together so opening the card reads them all', () => {
    const [group] = groupAlerts([alert(1, `/admin/bookings/${A}`), alert(2, `/admin/bookings/${A}`, '2026-10-12T15:00:00Z'), alert(3, `/admin/bookings/${A}`)])
    expect(group.unreadIds).toEqual([1, 3])
    const [allRead] = groupAlerts([alert(4, `/admin/bookings/${A}`, 'x'), alert(5, `/admin/bookings/${A}`, 'x')])
    expect(allRead.unreadIds).toEqual([])
  })
  it('leave alerts that point anywhere else on their own, even when the page is the same', () => {
    const groups = groupAlerts([alert(1, '/admin/waitlist'), alert(2, '/admin/waitlist'), alert(3, null)])
    expect(groups.map(group => group.head.id)).toEqual([1, 2, 3])
    expect(groups.every(group => group.older.length === 0)).toBe(true)
  })
  it('only treats a real booking link as a booking', () => {
    expect(bookingIdFromLink(`/admin/bookings/${A}`)).toBe(A)
    expect(bookingIdFromLink('/admin/bookings/not-an-id')).toBeNull()
    expect(groupAlerts([])).toEqual([])
  })
})
