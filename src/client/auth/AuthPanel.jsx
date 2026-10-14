import { useState } from 'react'
import { unwrap } from '../booking/bookingApi.js'
import { GENERIC } from '../booking/friendlyError.js'

// What the sign-in service says, in the words a client would use. Anything else stays out of sight.
const AUTH_MESSAGES = [
  [/invalid login credentials/i, "That email and password don't match. Please check them and try again."],
  [/already registered|already been registered/i, "There is already an account with that email. Please try signing in instead."],
  [/email not confirmed/i, 'Please confirm your email first. The link is in the message I sent you.'],
  [/password should be at least|password.*(short|weak)|least 8/i, 'Please choose a password of at least 8 characters.'],
  [/rate limit|too many/i, 'That has been tried a few times. Please wait a minute and try again.'],
]
const authMessage = (error) => AUTH_MESSAGES.find(([pattern]) => pattern.test(error?.message || ''))?.[1] || GENERIC

export default function AuthPanel({ client, recovery = false, onRecovered, onGuest, level = 1, heading: headingOverride, redirectTo: redirectOverride }) {
  const [mode, setMode] = useState('login')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const redirectTo = redirectOverride || `${window.location.origin}${window.location.pathname}?step=5`
  // Booking as a guest is the quick way on, so signing in waits behind "Returning client?" until it is asked for.
  const guestable = Boolean(onGuest) && !recovery
  const expanded = !guestable || open
  function go(next) { setMode(next); setOpen(true) }
  async function act(action) {
    setBusy(true); setError(''); setMessage('')
    try { await action() } catch (err) { setError(authMessage(err)) }
    finally { setBusy(false) }
  }
  function submit(event) {
    event.preventDefault()
    const fields = Object.fromEntries(new FormData(event.currentTarget))
    act(async () => {
      if (recovery) {
        await unwrap(client.auth.updateUser({ password: fields.password })); onRecovered(); return
      }
      if (mode === 'register') {
        const data = await unwrap(client.auth.signUp({ email: fields.email, password: fields.password,
          options: { emailRedirectTo: redirectTo, data: { first_name: fields.first_name, last_name: fields.last_name } } }))
        if (!data.session) setMessage('Check your email to confirm your account, then come back to this page to carry on. Your choices are saved, but I can only hold your time for a short while.')
      } else if (mode === 'reset') {
        await unwrap(client.auth.resetPasswordForEmail(fields.email, { redirectTo }))
        setMessage('Check your email for the password reset link.')
      } else await unwrap(client.auth.signInWithPassword({ email: fields.email, password: fields.password }))
    })
  }
  const heading = headingOverride && mode === 'login' && !recovery ? headingOverride : recovery ? 'Choose a new password' : mode === 'register' ? 'Create your account' : mode === 'reset' ? 'Reset your password' : 'Complete your booking'
  const form = <>
    <form onSubmit={submit}>
      <fieldset disabled={busy}>
        {mode === 'register' && !recovery && <div className="two-columns">
          <label>First name<input name="first_name" autoComplete="given-name" required /></label>
          <label>Last name<input name="last_name" autoComplete="family-name" required /></label>
        </div>}
        {!recovery && <label>Email address<input name="email" type="email" autoComplete="email" required /></label>}
        {(mode !== 'reset' || recovery) && <>
          <label>Password<input name="password" type="password" minLength={8} aria-describedby={mode === 'register' || recovery ? 'password-hint' : undefined} autoComplete={mode === 'register' || recovery ? 'new-password' : 'current-password'} required /></label>
          {(mode === 'register' || recovery) && <p className="field-hint" id="password-hint">At least 8 characters.</p>}
        </>}
        <button className="btn--primary btn--block" type="submit">{busy ? 'Please wait…' : recovery ? 'Save password' : mode === 'register' ? 'Register' : mode === 'reset' ? 'Send reset link' : 'Sign in'}</button>
      </fieldset>
    </form>
    {!recovery && <div className="actions">
      <button className="btn--quiet" disabled={busy} onClick={() => go(mode === 'register' ? 'login' : 'register')}>{mode === 'register' ? 'Already registered? Sign in' : 'Create an account'}</button>
      <button className="btn--quiet" disabled={busy} onClick={() => go(mode === 'reset' ? 'login' : 'reset')}>{mode === 'reset' ? 'Back to sign in' : 'Forgot password?'}</button>
    </div>}
  </>
  // Under the page header the panel is a section of the page, not its main heading.
  const Heading = level === 2 ? 'h2' : 'h1'
  return <section className="gate" aria-labelledby="gate-title">
    <Heading id="gate-title" tabIndex={-1}>{heading}</Heading>
    {mode === 'login' && !recovery
      ? <p className="lede">{onGuest ? 'Continue as a guest, or sign in if you already have an account.' : 'Sign in with the email you used to book.'}</p>
      : recovery || guestable ? <p className="lede">Your choices will stay here while you continue.</p> : null}
    {guestable && <button className="btn--primary btn--lg btn--block" type="button" disabled={busy} onClick={() => act(onGuest)}>
      {busy ? 'Please wait…' : 'Continue as guest'}
    </button>}
    {guestable ? <details className="signin more" open={expanded} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Returning client? Sign in</summary>
      {form}
    </details> : <div className="panel gate-form">{form}</div>}
    {error && <p role="alert" className="error">{error}</p>}
    {message && <p role="alert" className="notice">{message}</p>}
  </section>
}
