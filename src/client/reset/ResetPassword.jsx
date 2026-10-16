import { useEffect, useRef, useState } from 'react'
import Icon from '../../ui/icons.jsx'
import { supabase } from '../../lib/supabase.js'
import { authMessage } from '../auth/authMessage.js'
import { forgetRecovery, linkHasError, linkHasSecret, recoverySession } from './recoverySession.js'
import { passwordProblem } from './passwordProblem.js'
import '../booking/booking.css'

const TITLES = {
  checking: 'Choose a new password', ready: 'Choose a new password', saved: 'Password saved',
  expired: 'That link has expired', nolink: 'Reset your password',
}
// How long to wait for the sign-in library to announce a link it is reading, before saying there is none.
const WAIT_MS = 4000

// Where the link in a password reset email comes. The form is at the top, asks for the password twice, and leaves the client signed in. A link that
// was used already, or has run out, says so and offers a new one; so does the page opened without a link.
export default function ResetPassword() {
  const [state, setState] = useState(linkHasError ? 'expired' : 'checking')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const heading = useRef(null)

  useEffect(() => {
    if (linkHasError) return undefined
    let live = true
    let giveUp
    async function check() {
      try {
        const valid = await recoverySession()
        if (!live) return
        if (valid) { clearTimeout(giveUp); setState((current) => (current === 'saved' ? current : 'ready')); return }
        // A link being read is announced a moment later: wait for it before saying there is no link.
        if (!linkHasSecret) setState((current) => (current === 'saved' ? current : 'nolink'))
      } catch { if (live && !linkHasSecret) setState('nolink') }
    }
    // The library holds a lock while it announces something, so it is asked nothing until it has let go.
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'INITIAL_SESSION') setTimeout(() => { if (live) void check() }, 0)
      if (event === 'SIGNED_OUT' && live) setState((current) => (current === 'saved' ? current : 'nolink'))
    })
    giveUp = setTimeout(() => { if (live) setState((current) => (current === 'checking' ? 'nolink' : current)) }, WAIT_MS)
    void check()
    return () => { live = false; clearTimeout(giveUp); data.subscription.unsubscribe() }
  }, [])

  // A new screen starts at its heading, and the tab is named for it.
  useEffect(() => {
    document.title = `${TITLES[state]} · VadMassage`
    heading.current?.focus({ preventScroll: true })
  }, [state])
  // The link's secret is out of the address once it has been used, so a copied address or a screenshot does not carry it.
  useEffect(() => { if (state === 'ready' && window.location.hash) window.history.replaceState(null, '', window.location.pathname) }, [state])

  async function save(event) {
    event.preventDefault()
    if (pending.current) return
    const values = new FormData(event.currentTarget)
    const problem = passwordProblem(String(values.get('password') || ''), String(values.get('confirm') || ''))
    if (problem) { setError(problem); return }
    pending.current = true; setBusy(true); setError('')
    try {
      // Only the session the link made may change the password here.
      if (!await recoverySession()) { setState('nolink'); return }
      const { error: failure } = await supabase.auth.updateUser({ password: String(values.get('password')) })
      if (failure) throw failure
      forgetRecovery()
      setState('saved')
    } catch (failure) { setError(authMessage(failure)) }
    finally { pending.current = false; setBusy(false) }
  }

  async function sendAgain(event) {
    event.preventDefault()
    if (pending.current) return
    const email = String(new FormData(event.currentTarget).get('email') || '').trim()
    pending.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const { error: failure } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` })
      if (failure) throw failure
      // The same words whether or not there is an account for that email.
      setMessage("If there is an account for that email, I've sent a new link. It can take a minute, so please look in your junk folder too.")
    } catch (failure) { setError(authMessage(failure)) }
    finally { pending.current = false; setBusy(false) }
  }

  const asking = state === 'expired' || state === 'nolink'
  return <div className="booking-shell">
    <header className="brand"><a className="brand-link" href="/"><b className="brand-mark" aria-hidden="true">VM</b>VadMassage</a><a className="brand-aside" href="/">Book a treatment</a></header>
    <main className="booking-main">
      {state === 'saved' && <div className="success-mark" aria-hidden="true"><Icon name="tick" size={30} /></div>}
      <h1 tabIndex={-1} ref={heading}>{state === 'saved' ? <>Password <em>saved</em></>
        : state === 'expired' ? <>That link has <em>expired</em></> : state === 'nolink' ? <>Reset your <em>password</em></> : <>Choose a <em>new</em> password</>}</h1>

      {state === 'checking' && <p role="status">Checking your link…</p>}

      {state === 'ready' && <>
        <p className="lede">Pick a password you will remember. You will stay signed in.</p>
        <div className="panel gate-form">
          <form onSubmit={save}>
            <fieldset disabled={busy}>
              <label>New password<input name="password" type="password" autoComplete="new-password" aria-describedby="password-hint" required /></label>
              <p className="field-hint" id="password-hint">At least 8 characters.</p>
              <label>Type it again<input name="confirm" type="password" autoComplete="new-password" required /></label>
              <button className="btn--primary btn--block" type="submit">{busy ? 'Please wait…' : 'Save new password'}</button>
            </fieldset>
          </form>
        </div>
      </>}

      {state === 'saved' && <>
        <p className="lede">You are signed in. Next time, sign in with your new password.</p>
        <a className="btn btn--primary btn--block" href="/account">Your bookings</a>
        <a className="btn btn--tonal btn--block" href="/">Book a massage</a>
      </>}

      {asking && <>
        <p className="lede">{state === 'expired'
          ? 'A reset link works once, and stops working after a while. If you have already chosen a new password, you can sign in. If not, I will send you a new link.'
          : 'Enter the email you booked with and I will send you a link to choose a new password.'}</p>
        <div className="panel gate-form">
          <form onSubmit={sendAgain}>
            <fieldset disabled={busy}>
              <label>Email address<input name="email" type="email" autoComplete="email" required /></label>
              <button className="btn--primary btn--block" type="submit">{busy ? 'Please wait…' : 'Send me a new link'}</button>
            </fieldset>
          </form>
        </div>
        <a className="btn btn--quiet btn--block" href="/account">Sign in to see your bookings</a>
      </>}

      {error && <p role="alert" className="error">{error}</p>}
      {message && <p role="status" className="notice">{message}</p>}
    </main>
    <footer>Personal treatments, thoughtfully arranged. <a href="https://vadmassage.com">Contact Vad</a></footer>
  </div>
}
