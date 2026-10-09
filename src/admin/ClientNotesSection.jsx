import { useEffect, useState } from 'react'
import { clientsApi } from './clientsApi.js'

const stamp = value => new Date(value).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' })
const SHOWN = 3

// The Admin's private notes about this client (pressure, access, "ring the bell twice"), where she needs them: on the booking.
export default function ClientNotesSection({ clientId, api = clientsApi }) {
  const [notes, setNotes] = useState(null)
  useEffect(() => {
    if (!clientId) return undefined
    let live = true
    api.notes(clientId).then(rows => { if (live) setNotes(rows) }, () => { if (live) setNotes([]) })
    return () => { live = false }
  }, [api, clientId])
  if (!notes?.length) return null
  return <section aria-labelledby="private-notes-title"><h3 id="private-notes-title">Your notes about this client</h3>
    <ul className="admin-note-list">{notes.slice(0, SHOWN).map(note => <li key={note.id}><p>{note.note}</p><small>{stamp(note.created_at)}</small></li>)}</ul>
    {notes.length > SHOWN && <p className="admin-detail-hint">{notes.length - SHOWN} older {notes.length - SHOWN === 1 ? 'note is' : 'notes are'} on the client's page.</p>}
  </section>
}
