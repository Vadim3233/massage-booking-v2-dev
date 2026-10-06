import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import './admin.css'
import { recoverySession } from './recoverySession.js'

export default function ResetPassword({ linkError }) {
  const [state, setState] = useState('checking')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  useEffect(() => {
    let live = true
    async function check() {
      try {
        const valid = !linkError && await recoverySession()
        if (live) setState(valid ? 'ready' : 'invalid')
      } catch { if (live) setState('invalid') }
    }
    // Defer Auth calls until the SDK has released its auth-event lock.
    const { data } = supabase.auth.onAuthStateChange(event => {
      if (event === 'PASSWORD_RECOVERY' || event === 'INITIAL_SESSION') setTimeout(() => { if (live) void check() }, 0)
      if (event === 'SIGNED_OUT' && live) setState(current => current === 'changed' ? current : 'invalid')
    })
    void check()
    return () => { live = false; data.subscription.unsubscribe() }
  }, [linkError])
  async function finish() {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
    window.location.replace('/admin?password=changed')
  }
  async function submit(event) {
    event.preventDefault()
    if (pending.current) return
    const form = event.currentTarget
    const values = new FormData(form)
    const password = values.get('password')
    if (password !== values.get('confirm')) { setError('Passwords do not match.'); return }
    if (password.length < 6) { setError('Use at least 6 characters.'); return }
    pending.current = true; setBusy(true); setError('')
    let changed = false
    try {
      if (!await recoverySession()) { setState('invalid'); return }
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error
      changed = true; form.reset(); setState('changed')
      await finish()
    } catch {
      setError(changed ? 'Password changed, but sign out failed. Check your connection and retry sign out.' : 'Could not change the password. Try a different password, check your connection, or request a new reset link.')
    } finally { pending.current = false; setBusy(false) }
  }
  async function retrySignOut() {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { await finish() } catch { setError('Could not sign out. Check your connection and try again.') }
    finally { pending.current = false; setBusy(false) }
  }
  return <main className="admin-shell"><section className="admin-login"><h1>Reset Admin password</h1>
    {state === 'checking' && <p role="status">Checking recovery link…</p>}
    {state === 'invalid' && <p role="alert">This recovery link is invalid or expired, or the recovery session is missing. Request a new reset link.</p>}
    {state === 'ready' && <form onSubmit={submit}>
      <label>New password<input name="password" type="password" autoComplete="new-password" minLength={6} required disabled={busy} /></label>
      <label>Confirm new password<input name="confirm" type="password" autoComplete="new-password" minLength={6} required disabled={busy} /></label>
      <p>Use at least 6 characters.</p><button disabled={busy}>{busy ? 'Changing password…' : 'Change password'}</button>
    </form>}
    {state === 'changed' && <><p role="status">Password changed. Sign out to continue to sign in.</p><button disabled={busy} onClick={retrySignOut}>Retry sign out</button></>}
    {error && <p role="alert">{error}</p>}
    {state !== 'changed' && <a href="/admin?reset=request">Request a new reset link</a>}
  </section></main>
}
