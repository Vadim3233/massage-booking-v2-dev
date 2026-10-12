import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import AdminWorkspace from './AdminWorkspace.jsx'
import PasswordResetRequest from './PasswordResetRequest.jsx'
import './admin.css'

export default function AdminApp() {
  const [requestReset, setRequestReset] = useState(new URLSearchParams(window.location.search).get('reset') === 'request')
  const passwordChanged = new URLSearchParams(window.location.search).get('password') === 'changed'
  const [auth, setAuth] = useState({ state: 'checking' })
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true, revision = 0, checkedUser = null
    async function check(session) {
      const ticket = ++revision
      if (!session || session.user.is_anonymous) { checkedUser = null; if (live) setAuth({ state: 'signed-out' }); return }
      // Coming back to the tab (from the bank, say) makes the sign-in library announce the same person again.
      // That must not rebuild the screen: an open confirmation and the scroll position would be lost.
      if (checkedUser === session.user.id) return
      if (live) setAuth({ state: 'checking' })
      const { data, error } = await supabase.rpc('is_booking_admin')
      if (live && ticket === revision) {
        checkedUser = error ? null : session.user.id
        setAuth(error ? { state: 'error', error: error.message } : { state: data ? 'admin' : 'denied', userId: session.user.id })
      }
    }
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => { void check(session) })
    return () => { live = false; listener.subscription.unsubscribe() }
  }, [attempt])
  // Signed in, the workspace names each screen in the tab; until then this is the sign-in page.
  useEffect(() => { if (auth.state !== 'admin') document.title = 'Admin sign in · VadMassage' }, [auth.state])
  // Added to a phone's home screen, the Admin opens as the Admin (the booking page keeps its own icon and start page).
  useEffect(() => {
    const link = document.querySelector('link[rel="manifest"]')
    const name = document.querySelector('meta[name="apple-mobile-web-app-title"]')
    const before = [link?.getAttribute('href'), name?.getAttribute('content')]
    link?.setAttribute('href', '/admin.webmanifest')
    name?.setAttribute('content', 'Vad Admin')
    return () => { if (before[0]) link?.setAttribute('href', before[0]); if (before[1]) name?.setAttribute('content', before[1]) }
  }, [])
  async function signIn(event) {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    try { const { error } = await supabase.auth.signInWithPassword({ email: form.get('email'), password: form.get('password') }); if (error) throw error }
    catch (error) { setError(error.message) }
    finally { setBusy(false) }
  }
  async function signOut() { const { error } = await supabase.auth.signOut(); if (error) setError(error.message) }
  return <div className="admin-shell">
    {auth.state === 'admin' && !requestReset ? <AdminWorkspace key={auth.userId} ownerId={auth.userId} signOut={signOut} /> : <main><section className="admin-login"><div className="admin-login-brand"><b className="brand-mark" aria-hidden="true">VM</b><h1>VadMassage Admin</h1></div>
      {passwordChanged && <p role="status">Password changed. Please sign in with your new password.</p>}
      {requestReset && <PasswordResetRequest onBack={() => setRequestReset(false)} />}
      {!requestReset && auth.state === 'checking' && <p role="status">Checking authentication…</p>}
      {!requestReset && auth.state === 'signed-out' && <form onSubmit={signIn}><h2>Admin sign in</h2><label>Email<input name="email" type="email" autoComplete="username" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" required /></label><button className="admin-forgot" type="button" disabled={busy} onClick={() => setRequestReset(true)}>Forgot password?</button><button disabled={busy}>Sign in</button></form>}
      {!requestReset && auth.state === 'denied' && <><p role="alert">This account does not have Admin access.</p><button onClick={signOut}>Sign out</button></>}
      {!requestReset && auth.state === 'error' && <><p role="alert">{auth.error}</p><button onClick={() => setAttempt(value => value + 1)}>Retry authentication</button></>}
    </section></main>}
    {error && <p role="alert">{error}</p>}
  </div>
}
