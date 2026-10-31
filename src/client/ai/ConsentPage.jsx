import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useClientAuth } from '../auth/useClientAuth.js'
import AuthPanel from '../auth/AuthPanel.jsx'
import { WHAT_IT_CAN_DO, assistantDestination } from './aiConnector.js'
import '../booking/booking.css'

// Where a client's own AI assistant (Claude, ChatGPT…) sends them to sign in and allow it to book for them. Supabase's OAuth server opens this
// page as /oauth/consent?authorization_id=…; after Allow or No thanks, the client goes back to their assistant.
export default function ConsentPage({ client = supabase }) {
  const auth = useClientAuth(client)
  const authorizationId = new URLSearchParams(window.location.search).get('authorization_id') || ''
  const [details, setDetails] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const heading = useRef(null)
  // A guest's session is not an account, so it has to sign in first.
  const signedIn = Boolean(auth.session?.user && !auth.session.user.is_anonymous)

  useEffect(() => { document.title = 'Allow your assistant · VadMassage' }, [])
  useEffect(() => {
    if (!signedIn || !authorizationId) return undefined
    let live = true
    client.auth.oauth.getAuthorizationDetails(authorizationId).then(({ data, error: failure }) => {
      if (!live) return
      if (failure || !data) { setError('This sign-in link has expired. Please go back to your assistant and connect again.'); return }
      // Already allowed before: straight back to the assistant, if it is one VadMassage works with (an assistant allowed before ADR-085
      // could send the sign-in anywhere).
      if (data.redirect_url && !data.authorization_id) {
        if (assistantDestination(data.redirect_url).known) window.location.assign(data.redirect_url)
        else setDetails({ redirect_uri: data.redirect_url })
        return
      }
      setDetails(data)
    })
    return () => { live = false }
  }, [client, signedIn, authorizationId])
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [signedIn, details])

  async function decide(allow) {
    if (busy) return
    setBusy(true); setError('')
    const { data, error: failure } = allow
      ? await client.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
      : await client.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true })
    if (failure || !data?.redirect_url) { setBusy(false); setError('That did not work. Please go back to your assistant and connect again.'); return }
    window.location.assign(data.redirect_url)
  }

  const name = details?.client?.name || 'Your AI assistant'
  // The name is whatever the assistant registered with; where it sends the client back to is what tells a real one from a fake.
  const destination = assistantDestination(details?.redirect_uri)
  return <div className="booking-shell">
    <header className="brand"><a className="brand-link" href="/"><b className="brand-mark" aria-hidden="true">VM</b>VadMassage</a><a className="brand-aside" href="/book-with-ai">How this works</a></header>
    <main className="booking-main">
      {!authorizationId ? <>
        <h1 tabIndex={-1} ref={heading}>Book with your <em>AI assistant</em></h1>
        <p className="lede">This page opens from your assistant when you connect it. <a href="/book-with-ai">See how to connect it</a>.</p>
      </> : !auth.ready ? <p role="status">Loading…</p> : !signedIn ? <>
        <h1 tabIndex={-1} ref={heading}>Sign in to <em>connect</em></h1>
        <p className="lede">Sign in with your VadMassage account, then allow your assistant to book for you.</p>
        <AuthPanel client={client} startOpen redirectTo={window.location.href} heading="Sign in" level={2} />
      </> : error ? <>
        <h1 tabIndex={-1} ref={heading}>Something went <em>wrong</em></h1>
        <p role="alert" className="lede">{error}</p>
      </> : !details ? <p role="status">Loading…</p> : !destination.known ? <>
        <h1 tabIndex={-1} ref={heading}>This assistant <em>can't connect</em></h1>
        <p role="alert" className="lede">It would send your sign-in to {destination.host || 'an unknown address'}, which isn't an assistant VadMassage works with. To keep your account safe, nothing has been shared.</p>
        <p className="fine">VadMassage works with Claude, ChatGPT and Google Gemini. If you expected this to work, please message Vadim. <a href="/book-with-ai">See how to connect</a>.</p>
      </> : <>
        <h1 tabIndex={-1} ref={heading}>Allow <em>{name}</em>?</h1>
        <p className="lede">{name} wants to book appointments for you, as {auth.session.user.email}. It will be able to:</p>
        <ul className="consent-list">{WHAT_IT_CAN_DO.map(line => <li key={line}>{line}</li>)}</ul>
        <p className="fine">After you choose, you go back to {destination.label}.</p>
        <p className="fine">It always asks you before it books. It can't see other clients, take payments, or change or cancel bookings. You can disconnect it any time on the <a href="/book-with-ai">Book with AI</a> page.</p>
        <div className="action-bar">
          <button className="btn--primary btn--lg btn--block" disabled={busy} onClick={() => decide(true)}>{busy ? 'Please wait…' : 'Allow'}</button>
        </div>
        <button className="btn--quiet btn--block" disabled={busy} onClick={() => decide(false)}>No thanks</button>
      </>}
    </main>
  </div>
}
