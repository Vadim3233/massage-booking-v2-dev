import { useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'

export default function PasswordResetRequest({ onBack }) {
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  async function submit(event) {
    event.preventDefault()
    if (pending.current) return
    const email = new FormData(event.currentTarget).get('email').trim()
    pending.current = true
    setBusy(true); setError('')
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/admin/reset-password`,
      })
      if (error) throw error
      setSent(true)
    } catch {
      setError('Could not send the reset request. Check your connection and try again shortly.')
    } finally { pending.current = false; setBusy(false) }
  }
  return <><h2>Reset Admin password</h2>
    {sent ? <p role="status">If an account exists for this email, a password reset link has been sent.</p> :
      <form onSubmit={submit}><label>Admin email<input name="email" type="email" autoComplete="email" required disabled={busy} /></label>
        <button disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button></form>}
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={busy} onClick={onBack}>Back to sign in</button>
  </>
}
