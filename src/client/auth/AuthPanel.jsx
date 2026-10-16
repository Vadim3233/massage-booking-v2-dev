import { useState } from 'react'
import { unwrap } from '../booking/bookingApi.js'
import { authMessage } from './authMessage.js'
import { signUpOutcome } from './signUpOutcome.js'

export default function AuthPanel({ client, onGuest, startOpen = false, level = 1, heading: headingOverride, redirectTo: redirectOverride }) {
  const [mode, setMode] = useState('login')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [open, setOpen] = useState(startOpen)
  // After a sign-up that needs the email confirmed, what was typed stays here (in memory only, never saved) so the client can carry on from
  // this same page once the link has been opened, even when it opened in another app or browser.
  const [waiting, setWaiting] = useState(null)
  const redirectTo = redirectOverride || `${window.location.origin}${window.location.pathname}?step=5`
  // The link in a password reset email always opens the page that asks for the new password, whichever page the reset was asked for from.
  const resetRedirect = `${window.location.origin}/reset-password`
  // Booking as a guest is the quick way on, so it is the big button; signing in and creating an account sit plainly beside it.
  const guestable = Boolean(onGuest)
  function go(next) { setMode(next); setOpen(true); if (next !== 'register') setWaiting(null) }
  // The two buttons under "or use an account": a second tap on the one that is showing closes it again.
  function choose(next) {
    const showing = open && (next === 'register' ? mode === 'register' : mode !== 'register')
    if (showing) setOpen(false)
    else go(next)
  }
  async function act(action) {
    setBusy(true); setError(''); setMessage('')
    try { await action() } catch (err) { setError(authMessage(err)) }
    finally { setBusy(false) }
  }
  function submit(event) {
    event.preventDefault()
    const fields = Object.fromEntries(new FormData(event.currentTarget))
    act(async () => {
      if (mode === 'register') {
        const data = await unwrap(client.auth.signUp({ email: fields.email, password: fields.password,
          options: { emailRedirectTo: redirectTo, data: { first_name: fields.first_name, last_name: fields.last_name } } }))
        const outcome = signUpOutcome(data)
        if (outcome === 'confirm-email') setWaiting({ email: fields.email, password: fields.password })
        else if (outcome === 'already-registered') { setMode('login'); setError(authMessage({ message: 'already registered' })) }
      } else if (mode === 'reset') {
        await unwrap(client.auth.resetPasswordForEmail(fields.email, { redirectTo: resetRedirect }))
        setMessage("Check your email for the password reset link. If it doesn't come within a minute, please look in your junk folder too.")
      } else await unwrap(client.auth.signInWithPassword({ email: fields.email, password: fields.password }))
    })
  }
  // The link in the email may open somewhere else, so this signs in with what was just typed once it has been confirmed.
  function confirmed() {
    act(async () => { await unwrap(client.auth.signInWithPassword({ email: waiting.email, password: waiting.password })) })
  }
  function sendAgain() {
    act(async () => {
      await unwrap(client.auth.resend({ type: 'signup', email: waiting.email, options: { emailRedirectTo: redirectTo } }))
      setMessage("I've sent it again. Please look in your junk folder too.")
    })
  }
  const panelTitle = mode === 'register' ? 'Create your account' : mode === 'reset' ? 'Reset your password' : 'Sign in'
  const heading = guestable ? 'Complete your booking'
    : headingOverride && mode === 'login' ? headingOverride : mode === 'register' ? 'Create your account' : mode === 'reset' ? 'Reset your password' : 'Complete your booking'
  const form = <>
    <form onSubmit={submit}>
      <fieldset disabled={busy}>
        {mode === 'register' && <div className="two-columns">
          <label>First name<input name="first_name" autoComplete="given-name" required /></label>
          <label>Last name<input name="last_name" autoComplete="family-name" required /></label>
        </div>}
        <label>Email address<input name="email" type="email" autoComplete="email" required /></label>
        {mode !== 'reset' && <>
          <label>Password<input name="password" type="password" minLength={8} aria-describedby={mode === 'register' ? 'password-hint' : undefined} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required /></label>
          {mode === 'register' && <p className="field-hint" id="password-hint">At least 8 characters.</p>}
        </>}
        <button className="btn--primary btn--block" type="submit">{busy ? 'Please wait…' : mode === 'register' ? 'Register' : mode === 'reset' ? 'Send reset link' : 'Sign in'}</button>
      </fieldset>
    </form>
    {(guestable
      ? <div className="actions">
        {mode === 'register'
          ? <button className="btn--quiet" type="button" disabled={busy} onClick={() => go('login')}>Already registered? Sign in</button>
          : <button className="btn--quiet" type="button" disabled={busy} onClick={() => go(mode === 'reset' ? 'login' : 'reset')}>{mode === 'reset' ? 'Back to sign in' : 'Forgot password?'}</button>}
      </div>
      : <div className="actions">
        <button className="btn--quiet" type="button" disabled={busy} onClick={() => go(mode === 'register' ? 'login' : 'register')}>{mode === 'register' ? 'Already registered? Sign in' : 'Create an account'}</button>
        <button className="btn--quiet" type="button" disabled={busy} onClick={() => go(mode === 'reset' ? 'login' : 'reset')}>{mode === 'reset' ? 'Back to sign in' : 'Forgot password?'}</button>
      </div>)}
  </>
  const confirmation = waiting && <>
    <h2>Check your email</h2>
    <p role="alert" className="notice">I've sent a link to <b>{waiting.email}</b>. Open it, then come back to this page and press the button below.{guestable ? ' Your choices are saved here, but I can only hold your time for a short while.' : ''}</p>
    <button className="btn--primary btn--block" type="button" disabled={busy} onClick={confirmed}>{busy ? 'Please wait…' : "I've confirmed my email, continue"}</button>
    <div className="actions">
      <button className="btn--quiet" type="button" disabled={busy} onClick={sendAgain}>Send the email again</button>
      <button className="btn--quiet" type="button" disabled={busy} onClick={() => setWaiting(null)}>Use a different email</button>
    </div>
  </>
  // Under the page header the panel is a section of the page, not its main heading.
  const Heading = level === 2 ? 'h2' : 'h1'
  return <section className="gate" aria-labelledby="gate-title">
    <Heading id="gate-title" tabIndex={-1}>{heading}</Heading>
    {guestable
      ? <p className="lede">Book as a guest in a minute, or use an account to keep your details for next time.</p>
      : mode === 'login' ? <p className="lede">Sign in with the email you used to book.</p> : null}
    {guestable ? <>
      <button className="btn--primary btn--lg btn--block" type="button" disabled={busy} onClick={() => act(onGuest)}>
        {busy ? 'Please wait…' : 'Continue as guest'}
      </button>
      <p className="gate-or">or use an account</p>
      <div className="gate-choices">
        <button className="btn--tonal" type="button" disabled={busy} aria-expanded={open && mode !== 'register'} aria-controls={open ? 'gate-form' : undefined} onClick={() => choose('login')}>Sign in with email</button>
        <button className="btn--tonal" type="button" disabled={busy} aria-expanded={open && mode === 'register'} aria-controls={open ? 'gate-form' : undefined} onClick={() => choose('register')}>Create an account</button>
      </div>
      {open && <div className="panel gate-form" id="gate-form">
        {waiting ? confirmation : <>
          <h2>{panelTitle}</h2>
          {(mode === 'register' || mode === 'reset') && <p className="fine">Your choices stay on this page while you do this.</p>}
          {form}
        </>}
      </div>}
    </> : <div className="panel gate-form">{waiting ? confirmation : form}</div>}
    {error && <p role="alert" className="error">{error}</p>}
    {message && <p role="alert" className="notice">{message}</p>}
  </section>
}
