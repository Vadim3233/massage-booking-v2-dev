import { useEffect, useRef } from 'react'

// Coming back to the app (from the bank, or from WhatsApp) refreshes what is on screen, unless it was looked at a moment ago.
// A phone's home-screen app has no pull to refresh, so this is how a list stays true without her having to ask.
export function useReturnRefresh(refresh, quietMs = 5000) {
  const latest = useRef(refresh)
  const last = useRef(0)
  useEffect(() => { latest.current = refresh })
  useEffect(() => {
    last.current = Date.now()
    const back = () => {
      if (document.visibilityState === 'hidden' || Date.now() - last.current < quietMs) return
      last.current = Date.now()
      latest.current()
    }
    window.addEventListener('focus', back)
    document.addEventListener('visibilitychange', back)
    return () => { window.removeEventListener('focus', back); document.removeEventListener('visibilitychange', back) }
  }, [quietMs])
}
