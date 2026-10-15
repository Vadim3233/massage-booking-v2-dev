import { useEffect, useId, useRef, useState } from 'react'
import { clientsApi, fullName } from './clientsApi.js'
import { deleteQuestion, deleteScope, whyNotDelete } from './clientDelete.js'

// The last section of a client's page. Only a client with no bookings can go; for anyone else it says why not.
// The database decides: the page only reads its answer, and the command checks everything again before it deletes.
export default function DeleteClient({ client, deleted, api = clientsApi }) {
  const [check, setCheck] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // One key for this page: pressing again after a dropped connection cannot delete twice.
  const requestKey = useRef(null)
  const keep = useRef(null)
  const open = useRef(null)
  const reason = useRef(null)
  const problem = useRef(null)
  const returning = useRef(false)
  const explaining = useRef(false)
  const questionId = useId()
  const name = fullName(client)

  useEffect(() => {
    let live = true
    api.deleteCheck(client.id).then(value => { if (live) setCheck(value) }, () => { if (live) setCheck(false) })
    return () => { live = false }
  }, [api, client.id, attempt])
  // Asking moves to the safe choice; changing her mind moves back to the button she pressed.
  useEffect(() => {
    if (asking) keep.current?.focus()
    else if (returning.current) { returning.current = false; open.current?.focus() }
  }, [asking])
  // When pressing Delete finds a reason not to, the button she pressed is gone, so focus (and a screen reader) goes to the reason.
  useEffect(() => {
    if (check?.found && !check.can_delete && explaining.current) { explaining.current = false; reason.current?.focus() }
  }, [check])
  // A failure is read out and focus goes to it rather than being dropped when the buttons change.
  useEffect(() => { if (error) problem.current?.focus() }, [error])

  const recheck = () => { setCheck(null); setAttempt(value => value + 1) }
  // Looks again just before asking, so the question counts what is there now (an address or note added a moment ago).
  async function ask() {
    setBusy(true); setError('')
    try {
      const fresh = await api.deleteCheck(client.id)
      const can = Boolean(fresh?.found && fresh.can_delete)
      explaining.current = !can
      setCheck(fresh)
      setAsking(can)
    } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  function keepThem() { returning.current = true; setAsking(false) }
  async function remove() {
    if (busy) return
    setBusy(true); setError('')
    requestKey.current ??= crypto.randomUUID()
    try {
      await api.deleteClient(client.id, requestKey.current, deleteScope(check))
      deleted(name)
    } catch (failure) {
      // If the answer was lost on the way after the client was deleted, they are gone, which is what she asked for.
      const now = await api.deleteCheck(client.id).catch(() => null)
      if (now && now.found === false) { deleted(name); return }
      // Otherwise say what happened and read the page's answer again: they may now have a booking, or something may have changed.
      setError(failure.message); setAsking(false); setBusy(false)
      if (now) setCheck(now); else recheck()
    }
  }

  const ready = check?.found && check.can_delete
  return <section aria-labelledby="delete-title"><h2 id="delete-title">Delete this client</h2>
    {check === null && <p role="status">Checking…</p>}
    {check === false && <p role="alert">Could not check whether this client can be deleted. <button className="btn--small" onClick={() => { setError(''); recheck() }}>Try again</button></p>}
    {check && !check.found && <p>This client is no longer there. They may already have been deleted or combined.</p>}
    {check?.found && !check.can_delete && <>
      <p ref={reason} tabIndex={-1}>{whyNotDelete(name, check)}</p>
      {check.reason === 'booking_now' && <button className="btn--small" onClick={recheck}>Check again</button>}
    </>}
    {ready && !asking && <>
      <p className="admin-detail-hint">For someone added by mistake, a profile made twice or a made-up test profile.</p>
      <button ref={open} className="btn--small btn--danger" disabled={busy} onClick={ask}>Delete this client…</button>
    </>}
    {ready && asking && <div role="group" aria-labelledby={questionId} className="admin-conflicts">
      <p id={questionId}>{deleteQuestion(name, check)}</p>
      <div className="admin-payment-buttons admin-delete-choices">
        <button ref={keep} aria-describedby={questionId} disabled={busy} onClick={keepThem}>Keep {client.first_name}</button>
        <button className="btn--danger-solid" aria-describedby={questionId} disabled={busy} onClick={remove}>{busy ? 'Deleting…' : `Yes, delete ${client.first_name}`}</button>
      </div>
    </div>}
    {error && <p role="alert" tabIndex={-1} ref={problem}>{error}</p>}
  </section>
}
