import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useClientAuth } from '../auth/useClientAuth.js'
import { ASSISTANT_STEPS, connectorUrl, EXAMPLE_ASKS, WHAT_IT_CAN_DO } from './aiConnector.js'
import '../booking/booking.css'

// /book-with-ai: how a client connects their own AI assistant, the address to paste, and (when signed in) the assistants they have allowed,
// each with Disconnect.
export default function BookWithAi({ client = supabase }) {
  const auth = useClientAuth(client)
  const address = connectorUrl()
  const [copied, setCopied] = useState(false)
  const [grants, setGrants] = useState(null)
  const [error, setError] = useState('')
  const signedIn = Boolean(auth.session?.user && !auth.session.user.is_anonymous)

  useEffect(() => { document.title = 'Book with your AI assistant · VadMassage' }, [])
  useEffect(() => {
    if (!signedIn) return undefined
    let live = true
    client.auth.oauth.listGrants().then(({ data, error: failure }) => { if (live) setGrants(failure ? [] : data || []) }, () => { if (live) setGrants([]) })
    return () => { live = false }
  }, [client, signedIn])

  async function copy() {
    try { await navigator.clipboard.writeText(address); setCopied(true) } catch { setCopied(false) }
  }
  async function disconnect(grant) {
    setError('')
    const { error: failure } = await client.auth.oauth.revokeGrant({ clientId: grant.client.id })
    if (failure) { setError('That did not work. Please try again.'); return }
    setGrants(current => current.filter(item => item.client.id !== grant.client.id))
  }

  return <div className="booking-shell">
    <header className="brand"><a className="brand-link" href="/"><b className="brand-mark" aria-hidden="true">VM</b>VadMassage</a><a className="brand-aside" href="/">Book in the app</a></header>
    <main className="booking-main">
      <h1 tabIndex={-1}>Book with your <em>AI assistant</em></h1>
      <p className="lede">If you use Claude, ChatGPT or another AI assistant, you can ask it to book with me. It signs in with your VadMassage account, so you need an account and a saved address first.</p>
      <section className="panel ai-connect">
        <h2>1. Copy this address</h2>
        <div className="ai-address"><code>{address}</code><button type="button" className="btn--tonal btn--small" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button></div>
        <p className="fine" role="status">{copied ? 'The address is copied.' : ''}</p>
      </section>
      <section className="panel ai-connect">
        <h2>2. Add it to your assistant</h2>
        {ASSISTANT_STEPS.map(item => <div key={item.name}><h3>{item.name}</h3><ol>{item.steps.map(step => <li key={step}>{step}</li>)}</ol></div>)}
        <p className="fine">Other assistants that support MCP connectors work the same way: add a connector with this address, then sign in.</p>
      </section>
      <section className="panel ai-connect">
        <h2>3. Just ask</h2>
        <ul>{EXAMPLE_ASKS.map(line => <li key={line}>“{line}”</li>)}</ul>
        <p className="fine">Your assistant can:</p>
        <ul className="consent-list">{WHAT_IT_CAN_DO.map(line => <li key={line}>{line}</li>)}</ul>
        <p className="fine">It always asks you before it books, and it never takes a payment. New addresses, bookings for three or more people, extras, and changing or cancelling are done in <a href="/account">your account</a>. Please don't share health details through your assistant: I ask about those myself.</p>
      </section>
      {signedIn && <section className="panel ai-connect">
        <h2>Connected assistants</h2>
        {grants === null ? <p role="status">Loading…</p> : grants.length === 0 ? <p className="fine">None yet.</p>
          : <ul className="ai-grants">{grants.map(grant => <li key={grant.client.id}><span>{grant.client.name || 'An assistant'}</span>
            <button type="button" className="btn--quiet btn--small" onClick={() => disconnect(grant)}>Disconnect</button></li>)}</ul>}
        {error && <p role="alert" className="field-problem">{error}</p>}
      </section>}
    </main>
  </div>
}
