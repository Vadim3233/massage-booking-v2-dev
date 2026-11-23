import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { createCalendarApi } from './calendarApi.js'
import { useQuietRetry, useReturnRefresh } from './useReturnRefresh.js'
import { mergeRanges, rangePieces, readOptions, writeOptions } from './calendarGrid.js'

const api = createCalendarApi(supabase)
// Identical reads share one answer (StrictMode's repeated effect); a read asked for after a change is a new read.
const pending = new Map()
function loadRange(start, end, version) {
  const key = `${start}:${end}:${version}`
  if (!pending.has(key)) pending.set(key, Promise.all(rangePieces(start, end).map(([from, to]) => api.loadCalendarRange(from, to))).then(mergeRanges).finally(() => pending.delete(key)))
  return pending.get(key)
}

// What is in the diary from start to end (end not included), read again after any change, when the app comes back to the front, and when asked.
// What was on screen stays there while it is read again, so changing month never blanks the page.
export function useCalendarRange(start, end, revision) {
  const [loaded, setLoaded] = useState(null)
  const [failure, setFailure] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const reread = useCallback(() => setAttempt(value => value + 1), [])
  const quiet = useQuietRetry(reread)
  const shown = useRef(null)
  const key = `${start}:${end}`
  useEffect(() => {
    let live = true
    loadRange(start, end, `${attempt}:${revision}`).then(data => {
      if (!live) return
      shown.current = key
      quiet.succeeded()
      setLoaded({ key, data })
      setFailure(null)
    }, error => {
      if (!live) return
      if (shown.current === key && quiet.failed()) return
      setFailure({ key, message: error.message })
    })
    return () => { live = false }
  }, [start, end, key, attempt, revision, quiet])
  useReturnRefresh(reread)
  return {
    data: loaded?.data || null,
    current: loaded?.key === key,
    failed: failure?.key === key,
    retry: () => { quiet.asked(); reread() },
    reread,
  }
}

// True on a phone-sized screen (under 768 px wide), and kept true to the screen as it turns.
export function useNarrow() {
  const query = '(max-width: 767px)'
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches)
  useEffect(() => {
    const list = window.matchMedia?.(query)
    if (!list) return
    const change = () => setNarrow(list.matches)
    list.addEventListener('change', change)
    return () => list.removeEventListener('change', change)
  }, [])
  return Boolean(narrow)
}

// The View options ticks, kept on this device.
export function useViewOptions() {
  const [options, setOptions] = useState(readOptions)
  const change = useCallback((key, value) => setOptions(old => { const next = { ...old, [key]: value }; writeOptions(next); return next }), [])
  return [options, change]
}

// Keys on a computer: T for today, the arrow keys for the previous and next week or month. Never while typing or with a window open.
export function useCalendarKeys(handlers, path) {
  const latest = useRef(handlers)
  useEffect(() => { latest.current = handlers })
  useEffect(() => {
    const press = event => {
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return
      // Only while the view itself is on screen, not with a booking open over it.
      if (path && window.location.pathname !== path) return
      const target = event.target
      if (target?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"], dialog')) return
      if (document.querySelector('[role="dialog"], dialog[open]')) return
      const action = { t: 'today', T: 'today', ArrowLeft: 'previous', ArrowRight: 'next' }[event.key]
      if (action && latest.current[action]) { event.preventDefault(); latest.current[action]() }
    }
    window.addEventListener('keydown', press)
    return () => window.removeEventListener('keydown', press)
  }, [path])
}

