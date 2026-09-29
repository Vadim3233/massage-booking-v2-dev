import { useState } from 'react'
export default function AuthPanel({ api, recovery = false, onRecovered, onGuest }) {
  const [mode, setMode] = useState('login')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const redirectTo = `${window.location.origin}${window.location.pathname}?step=5`
  async function act(action) {
    setBusy(true); setError(''); setMessage('')
    try { await action() } catch (err) { setError(err.message || 'Sign-in failed. Please retry.') }
    finally { setBusy(false) }
  }
  function submit(event) {
    event.preventDefault()
    const fields = Object.fromEntries(new FormData(event.currentTarget))
    act(async () => {
      if (recovery) {
        await api.updatePassword(fields.password); onRecovered(); return
      }
      if (mode === 'register') {
        const data = await api.signUp({
          email: fields.email,
          password: fields.password,
          redirectTo,
          firstName: fields.first_name,
          lastName: fields.last_name,
        })
        if (!data.session) setMessage('Check your email to confirm your account, then return to this booking. Your selections stay here while the time hold remains active.')
      } else if (mode === 'reset') {
        await api.resetPasswordForEmail({ email: fields.email, redirectTo })
        setMessage('Check your email for the password reset link.')
      } else await api.signInWithPassword({ email: fields.email, password: fields.password })
    })
  }
  const heading = recovery ? 'Choose a new password' : mode === 'register' ? 'Create your account' : mode === 'reset' ? 'Reset your password' : 'Complete your booking'
  return <section className="panel">
    <h2>{heading}</h2>
    {mode === 'login' && !recovery
      ? <p>Continue as a guest, or sign in if you already have an account.</p>
      : <p>Your selections will stay here while you continue.</p>}
    {mode === 'login' && !recovery && <button className="primary" type="button" disabled={busy} onClick={() => act(onGuest)}>
      {busy ? 'Please wait…' : 'Continue as guest'}
    </button>}
    {mode === 'login' && !recovery && <p><strong>Returning client?</strong> Sign in below.</p>}
    <form onSubmit={submit}>
      <fieldset disabled={busy}>
        {mode === 'register' && !recovery && <div className="two-columns">
          <label>First name<input name="first_name" autoComplete="given-name" required /></label>
          <label>Last name<input name="last_name" autoComplete="family-name" required /></label>
        </div>}
        {!recovery && <label>Email address<input name="email" type="email" autoComplete="email" required /></label>}
        {(mode !== 'reset' || recovery) && <label>Password<input name="password" type="password" minLength={8} autoComplete={mode === 'register' || recovery ? 'new-password' : 'current-password'} required /></label>}
        <button className="primary" type="submit">{busy ? 'Please wait…' : recovery ? 'Save password' : mode === 'register' ? 'Register' : mode === 'reset' ? 'Send reset link' : 'Sign in'}</button>
      </fieldset>
    </form>
    {!recovery && <div className="actions">
      <button disabled={busy} onClick={() => setMode(mode === 'register' ? 'login' : 'register')}>{mode === 'register' ? 'Already registered? Sign in' : 'Create an account'}</button>
      <button disabled={busy} onClick={() => setMode(mode === 'reset' ? 'login' : 'reset')}>{mode === 'reset' ? 'Back to sign in' : 'Forgot password?'}</button>
    </div>}
    {error && <p role="alert" className="error">{error}</p>}
    {message && <p role="status">{message}</p>}
  </section>
}
