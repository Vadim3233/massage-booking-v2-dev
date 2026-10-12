import { useCallback, useEffect, useRef, useState } from 'react'
import { loadReviewResource, paymentReviewApi } from './paymentReviewApi.js'

// What needs the Admin right now: transfers the client says they made, and cash requests to decide.
// Bookings still waiting for the client to pay are counted apart, because nothing is asked of the Admin yet.
const NEEDS_YOU = ['awaiting_verification', 'awaiting_approval']

export function summariseToCheck(bookings) {
  const needs = bookings.filter(booking => NEEDS_YOU.includes(booking.booking_payments?.status))
  return { needs, waiting: bookings.length - needs.length, total: needs.reduce((sum, booking) => sum + Number(booking.total_gbp || 0), 0), loaded: true }
}

const EMPTY = { needs: [], waiting: 0, total: 0, loaded: false }

// Refreshes on a timer, whenever the app regains focus (she often comes back from her banking app), and whenever `trigger` changes.
export function useToCheck(trigger = 0, api = paymentReviewApi, intervalMs = 60000) {
  const [state, setState] = useState(EMPTY)
  const [tick, setTick] = useState(0)
  const lastRead = useRef(0)
  useEffect(() => {
    let live = true
    lastRead.current = Date.now()
    // The Payment review page asks for the same list; asking together is one read.
    loadReviewResource(`queue:0:${trigger}`, () => api.queue(0), 3000).then(({ bookings }) => { if (live) setState(summariseToCheck(bookings)) }, () => {})
    return () => { live = false }
  }, [api, tick, trigger])
  useEffect(() => {
    const refresh = () => setTick(value => value + 1)
    // Switching away and straight back is not worth another read; a real absence is.
    const comeBack = () => { if (Date.now() - lastRead.current > 5000) refresh() }
    const timer = setInterval(refresh, intervalMs)
    window.addEventListener('focus', comeBack)
    document.addEventListener('visibilitychange', comeBack)
    return () => { clearInterval(timer); window.removeEventListener('focus', comeBack); document.removeEventListener('visibilitychange', comeBack) }
  }, [intervalMs])
  return [state, useCallback(() => setTick(value => value + 1), [])]
}
