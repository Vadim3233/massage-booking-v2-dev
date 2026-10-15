import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadReviewResource, needsYou, paymentReviewApi } from './paymentReviewApi.js'
import { activeReminder, useReminders } from './paymentReminders.js'

// What needs the Admin right now: transfers the client says they made, and cash requests to decide, except the ones she has put off with "Not yet"
// until their time. Bookings still waiting for the client to pay are counted apart, because nothing is asked of the Admin yet.
export function summariseToCheck(bookings, reminders = {}, now = Date.now()) {
  const asking = bookings.filter(needsYou)
  const snoozed = asking.filter(booking => activeReminder(booking, reminders, now))
  const needs = asking.filter(booking => !snoozed.includes(booking))
  return { needs, snoozed, waiting: bookings.length - asking.length, total: needs.reduce((sum, booking) => sum + Number(booking.total_gbp || 0), 0), loaded: true }
}

const EMPTY = { needs: [], snoozed: [], waiting: 0, total: 0, loaded: false }

// Refreshes on a timer, whenever the app regains focus (she often comes back from her banking app), and whenever `trigger` changes.
// A reminder that has come due is noticed within half a minute, with no new read.
export function useToCheck(trigger = 0, api = paymentReviewApi, intervalMs = 60000) {
  const [bookings, setBookings] = useState(null)
  const [tick, setTick] = useState(0)
  const [now, setNow] = useState(Date.now)
  const reminders = useReminders()
  const lastRead = useRef(0)
  useEffect(() => {
    let live = true
    lastRead.current = Date.now()
    // The Payment review page asks for the same list; asking together is one read.
    loadReviewResource(`queue:0:${trigger}`, () => api.queue(0), 3000).then(data => { if (live) { setBookings(data.bookings); setNow(Date.now()) } }, () => {})
    return () => { live = false }
  }, [api, tick, trigger])
  useEffect(() => {
    const refresh = () => setTick(value => value + 1)
    // Switching away and straight back is not worth another read; a real absence is.
    const comeBack = () => { if (Date.now() - lastRead.current > 5000) refresh() }
    const timer = setInterval(refresh, intervalMs)
    const clock = setInterval(() => setNow(Date.now()), 30000)
    window.addEventListener('focus', comeBack)
    document.addEventListener('visibilitychange', comeBack)
    return () => { clearInterval(timer); clearInterval(clock); window.removeEventListener('focus', comeBack); document.removeEventListener('visibilitychange', comeBack) }
  }, [intervalMs])
  const state = useMemo(() => (bookings ? summariseToCheck(bookings, reminders, now) : EMPTY), [bookings, reminders, now])
  return [state, useCallback(() => setTick(value => value + 1), [])]
}
