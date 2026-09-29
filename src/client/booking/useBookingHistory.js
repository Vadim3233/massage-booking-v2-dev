import { useEffect } from 'react'
import { parseBookingStep } from './bookingDraft.js'

export function useBookingHistory(store, step) {
  useEffect(() => {
    const url = new URL(window.location.href)
    const requested = parseBookingStep(url.searchParams.get('step'))
    if (requested !== step || window.history.state?.bookingStep === undefined) {
      url.searchParams.set('step', step)
      window.history.replaceState({ ...window.history.state, bookingStep: step }, '', url)
    }
    const pop = () => store.navigate(parseBookingStep(new URLSearchParams(window.location.search).get('step')))
    const leave = (event) => {
      const { draft } = store.getSnapshot()
      if (draft.sessions.length && !draft.bookingId) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('popstate', pop)
    window.addEventListener('beforeunload', leave)
    return () => { window.removeEventListener('popstate', pop); window.removeEventListener('beforeunload', leave) }
  }, [store, step])
  return (requested) => {
    if (requested < step && window.history.state?.previousBookingStep === requested) {
      window.history.back()
      return
    }
    store.navigate(requested)
    const next = store.getSnapshot().step
    if (next !== step) {
      const url = new URL(window.location.href)
      url.searchParams.set('step', next)
      window.history.pushState({ bookingStep: next, previousBookingStep: step }, '', url)
      window.scrollTo(0, 0)
    }
  }
}
