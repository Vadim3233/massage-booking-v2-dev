import { useState } from 'react'
import { phoneProblem } from '../lib/phone.js'
import { toast } from '../ui/toast.js'
import { ClientForm } from './ClientForms.jsx'
import { clientsApi } from './clientsApi.js'

// The booking's Contact section, with Edit contact details: the same form and phone check as Clients › client › Edit details, so a wrong
// number can be put right from the booking itself. It changes the client's saved details; the email this booking's messages go to was
// taken when it was booked, so when that differs it is said plainly.
export default function ContactEdit({ booking, refresh, api = clientsApi }) {
  const [editing, setEditing] = useState(false)
  const client = booking.clients
  const bookingEmail = booking.booking_email_snapshot || client?.email
  const phone = client?.phone
  const shown = <>
    <p>{bookingEmail ? <a href={`mailto:${bookingEmail}`}>{bookingEmail}</a> : 'Email not recorded'}</p>
    <p>{phone ? <a href={`tel:${phone}`}>{phone}</a> : 'Phone not recorded'}</p>
    {phoneProblem(phone) && !editing && <p role="status" className="admin-field-error">This phone number looks wrong. {phoneProblem(phone)}</p>}
    {client?.email && booking.booking_email_snapshot && client.email !== booking.booking_email_snapshot.trim().toLowerCase() && <p className="admin-detail-hint">The client's saved email is now {client.email}. Messages about this booking still go to the email it was booked with.</p>}
  </>
  if (!client?.id) return shown
  if (!editing) return <>{shown}<button className="btn--quiet btn--small" onClick={() => setEditing(true)}>Edit contact details</button></>
  return <>{shown}<section aria-label="Edit contact details"><ClientForm initial={client} submitLabel="Save details" onCancel={() => setEditing(false)} onSubmit={async details => {
    await api.update(client.id, details)
    setEditing(false)
    toast('Contact details saved.')
    await refresh()
  }} /></section></>
}
