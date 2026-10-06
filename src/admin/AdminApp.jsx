import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import Calendar from './Calendar.jsx'
import './admin.css'

export default function AdminApp() {
  const [auth, setAuth] = useState({ state: 'checking' })
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true, revision = 0
    async function check(session) {
      const ticket = ++revision
      if (!session || session.user.is_anonymous) { if (live) setAuth({ state: 'signed-out' }); return }
      if (live) setAuth({ state: 'checking' })
      const { data, error } = await supabase.rpc('is_booking_admin')
      if (live && ticket === revision) setAuth(error ? { state: 'error', error: error.message } : { state: data ? 'admin' : 'denied' })
    }
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => { void check(session) })
    return () => { live = false; listener.subscription.unsubscribe() }
  }, [attempt])
  async function signIn(event) {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    try { const { error } = await supabase.auth.signInWithPassword({ email: form.get('email'), password: form.get('password') }); if (error) throw error }
    catch (error) { setError(error.message) }
    finally { setBusy(false) }
  }
  async function signOut() { const { error } = await supabase.auth.signOut(); if (error) setError(error.message) }
  return <main className="admin-shell">
    {auth.state === 'admin' ? <Calendar signOut={signOut} /> : <section className="admin-login"><h1>VadMassage Admin</h1>
      {auth.state === 'checking' && <p role="status">Checking authentication…</p>}
      {auth.state === 'signed-out' && <form onSubmit={signIn}><h2>Admin sign in</h2><label>Email<input name="email" type="email" autoComplete="username" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" required /></label><button disabled={busy}>Sign in</button></form>}
      {auth.state === 'denied' && <><p role="alert">This account does not have Admin access.</p><button onClick={signOut}>Sign out</button></>}
      {auth.state === 'error' && <><p role="alert">{auth.error}</p><button onClick={() => setAttempt(value => value + 1)}>Retry authentication</button></>}
    </section>}
    {error && <p role="alert">{error}</p>}
  </main>
}
