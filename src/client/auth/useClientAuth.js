import { useEffect, useState } from 'react'

export function useClientAuth(api) {
  const [auth, setAuth] = useState({ session: null, ready: false, error: '', recovery: false })
  useEffect(() => {
    let live = true
    api.getSession()
      .then((data) => {
        if (live) setAuth((current) => ({ ...current, session: data?.session || null, ready: true, error: '' }))
      })
      .catch((error) => {
        if (live) setAuth((current) => ({ ...current, ready: true, error: error.message || 'Unable to check your account.' }))
      })
    const unsubscribe = api.onAuthStateChange((event, session) => {
      if (live) setAuth((current) => ({ ...current, session, ready: true, recovery: event === 'PASSWORD_RECOVERY' || current.recovery }))
    })
    return () => { live = false; unsubscribe() }
  }, [api])
  return { ...auth, finishRecovery: () => setAuth((current) => ({ ...current, recovery: false })) }
}
