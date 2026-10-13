import { useEffect } from 'react'

export function useBookingHistory(store, step) {
  useEffect(() => {
    const url = new URL(window.location.href)
    const requested = Number(url.searchParams.get('step')) || 0
    if (requested !== step || window.history.state?.bookingStep === undefined) {
      url.searchParams.set('step', step)
      window.history.replaceState({ ...window.history.state, bookingStep: step }, '', url)
    }
    const pop = () => {
      const wanted = Number(new URLSearchParams(window.location.search).get('step')) || 0
      store.navigate(wanted)
      const { step: actual, draft } = store.getSnapshot()
      if (actual === wanted) return
      // A step that cannot be left (a reserved time has no way back) keeps the address true, and says why nothing happened.
      const here = new URL(window.location.href)
      here.searchParams.set('step', actual)
      window.history.replaceState({ ...window.history.state, bookingStep: actual }, '', here)
      if (draft.bookingId) store.setError(actual === 7 ? 'Your booking has been made, so there is no going back. To change or cancel it, use the links below.' : 'Your time is reserved, so there is no going back from here. To change the time or cancel, use the link at the bottom of the page.')
    }
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
