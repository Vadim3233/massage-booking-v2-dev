import { useEffect, useState } from 'react'

export function useClientAuth(client) {
  const [auth, setAuth] = useState({ session: null, ready: false, error: '' })
  useEffect(() => {
    let live = true
    client.auth.getSession().then(({ data, error }) => {
      if (live) setAuth((current) => ({ ...current, session: data?.session, ready: true, error: error?.message || '' }))
    })
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      if (live) setAuth((current) => ({ ...current, session, ready: true }))
    })
    return () => { live = false; data.subscription.unsubscribe() }
  }, [client])
  return auth
}
