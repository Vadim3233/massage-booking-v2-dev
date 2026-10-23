import { useEffect, useState } from 'react'
import { ReminderBox } from './PaymentReminder.jsx'
import { combinedReminderText, reminderDue } from './shareBooking.js'

// On a client's profile: one payment reminder for everything they owe, when they owe for more than one booking (with one, the booking's own page has
// the reminder). It lists each session and the total, so the client can pay it all in one transfer. Nothing shows when there is nothing to say.
export default function ClientPaymentReminder({ client, api, version, getBank, now = () => new Date() }) {
  const [due, setDue] = useState([])
  useEffect(() => {
    let live = true
    api.outstandingPayments(client.id).then(rows => { if (live) setDue((rows || []).filter(row => reminderDue(row, now()))) }, () => { if (live) setDue([]) })
    return () => { live = false }
  }, [api, client.id, version]) // eslint-disable-line react-hooks/exhaustive-deps
  if (due.length < 2) return null
  return <section aria-labelledby="owed-title"><h2 id="owed-title">Payment reminder</h2>
    <p className="admin-detail-hint">{client.first_name || 'This client'} owes for {due.length} bookings. One message lists them all and the total.</p>
    <ReminderBox label="Remind about all" phone={client.phone} getBank={getBank} makeText={bank => combinedReminderText(due, bank, client.first_name)} />
  </section>
}
