import { useEffect, useState } from 'react'
import { clearAdminDraft, loadAdminDraft, meaningfulDraft, saveAdminDraft } from './adminBookingDraft.js'

const readStep = () => Math.max(0, Math.min(4, Number(new URLSearchParams(window.location.search).get('step')) || 0))
export function useAdminBookingDraft(initialDate, ownerId) {
  const [draft, setDraft] = useState(() => loadAdminDraft(ownerId, initialDate))
  const [step, setStep] = useState(readStep)
  useEffect(() => {
    const pop = () => setStep(readStep())
    window.addEventListener('popstate', pop)
    return () => window.removeEventListener('popstate', pop)
  }, [])
  function patch(change) {
    setDraft(previous => {
      const next = { ...previous, ...change }
      saveAdminDraft(ownerId, next)
      return next
    })
  }
  function goStep(value, replace = false) {
    const next = Math.max(0, Math.min(4, value))
    const url = new URL(window.location.href)
    url.searchParams.set('step', String(next))
    window.history[replace ? 'replaceState' : 'pushState']({ ...window.history.state, adminWizard: true }, '', url)
    window.dispatchEvent(new PopStateEvent('popstate'))
    setStep(next)
    window.scrollTo(0, 0)
  }
  return { draft, patch, step, goStep, clear: () => clearAdminDraft(ownerId), meaningful: meaningfulDraft(draft) }
}
