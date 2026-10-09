import { useCallback, useEffect, useState } from 'react'
import { alertsApi } from './alertsApi.js'

// Unread alert count for the navigation badge. Refreshes on a timer and whenever the app regains focus,
// so a new booking shows up without reloading. Failures leave the last known number in place.
export function useUnreadAlerts(api = alertsApi, intervalMs = 60000) {
  const [count, setCount] = useState(0)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    api.unread().then(value => { if (live) setCount(value) }, () => {})
    return () => { live = false }
  }, [api, tick])
  useEffect(() => {
    const refresh = () => setTick(value => value + 1)
    const timer = setInterval(refresh, intervalMs)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [intervalMs])
  return [count, useCallback(() => setTick(value => value + 1), [])]
}
