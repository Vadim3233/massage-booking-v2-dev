import { useEffect, useState } from 'react'

export function useClientAuth(client) {
  const [auth, setAuth] = useState({ session: null, ready: false, error: '', recovery: false })
  useEffect(() => {
    let live = true
    client.auth.getSession().then(({ data, error }) => {
      if (live) setAuth((current) => ({ ...current, session: data?.session, ready: true, error: error?.message || '' }))
    })
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (live) setAuth((current) => ({ ...current, session, ready: true, recovery: event === 'PASSWORD_RECOVERY' || current.recovery }))
    })
    return () => { live = false; data.subscription.unsubscribe() }
  }, [client])
  return { ...auth, finishRecovery: () => setAuth((current) => ({ ...current, recovery: false })) }
}
