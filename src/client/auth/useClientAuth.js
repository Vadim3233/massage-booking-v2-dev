import { useEffect, useState } from 'react'

// The sign-in library's own wording ("Invalid Refresh Token", "Failed to fetch") is not for clients.
export const SIGN_IN_CHECK_FAILED = "I couldn't check whether you are signed in just now. Please refresh the page."

export function useClientAuth(client) {
  const [auth, setAuth] = useState({ session: null, ready: false, error: '' })
  useEffect(() => {
    let live = true
    client.auth.getSession().then(({ data, error }) => {
      if (live) setAuth((current) => ({ ...current, session: data?.session, ready: true, error: error ? SIGN_IN_CHECK_FAILED : '' }))
    })
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      if (live) setAuth((current) => ({ ...current, session, ready: true }))
    })
    return () => { live = false; data.subscription.unsubscribe() }
  }, [client])
  return auth
}
