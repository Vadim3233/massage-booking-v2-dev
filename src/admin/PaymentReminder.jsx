import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import Icon from '../ui/icons.jsx'
import { bankFromSettings, chooseBank, paymentConfig } from '../client/booking/paymentConfig.js'
import { combinedReminderText, owedTotal, reminderText, whatsappShareLink } from './shareBooking.js'
import { money } from './calendarPresentation.js'

const fallbackBank = paymentConfig(import.meta.env)

// The bank details the client's own booking page shows: the saved ones, or the site's own when none are saved.
async function loadBank() {
  try {
    const { data } = await supabase.rpc('get_bank_details')
    return chooseBank(bankFromSettings(data), fallbackBank)
  } catch { return fallbackBank }
}

// A payment reminder: a button that shows the reminder first, so it can be read, then opens it in the client's WhatsApp chat or copies it. Nothing is
// sent by itself, and it can still be changed in WhatsApp before sending. `makeText` writes the reminder from the bank details; `phone` is the client's.
export function ReminderBox({ makeText, phone, label = 'Payment reminder', getBank = loadBank }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState('')
  async function show() {
    setBusy(true); setSaid('')
    setText(makeText(await getBank()))
    setBusy(false)
  }
  async function copy() {
    try { await navigator.clipboard.writeText(text); setSaid('Copied') } catch { setSaid('Could not copy. Select the message and copy it.') }
  }
  const whatsapp = text && whatsappShareLink({ clients: { phone } }, text)
  return <div className="admin-payment-reminder">
    {!text
      ? <div className="admin-payment-buttons"><button className="btn--tonal" disabled={busy} onClick={show}><Icon name="bell" />{busy ? 'Getting the details...' : label}</button></div>
      : <>
        <pre className="admin-share-preview">{text}</pre>
        <div className="admin-payment-buttons">
          {whatsapp && <a className="btn btn--tonal" href={whatsapp} target="_blank" rel="noopener noreferrer"><Icon name="chat" />Remind on WhatsApp</a>}
          <button className="btn--tonal" onClick={copy}><Icon name="copy" />Copy reminder</button>
          <button className="btn--quiet btn--small" onClick={() => { setText(''); setSaid('') }}>Close</button>
        </div>
        {!whatsapp && <p className="admin-detail-hint">There is no phone number for WhatsApp, so copy the reminder instead.</p>}
        {said && <p role="status">{said}</p>}
      </>}
  </div>
}

// "Payment reminder", on a booking whose bank transfer is still to come (a client who pays later). `owing` is every booking this client can be
// reminded about, this one included: when there is more than one, the reminder offered first is one message that lists them all with the total,
// so the client is not sent a reminder for each. The reminder for this booking alone is still there underneath.
export default function PaymentReminder({ booking, owing = [], getBank }) {
  const phone = booking.clients?.phone
  const single = bank => reminderText(booking, bank)
  if (owing.length < 2) return <section aria-label="Payment reminder"><ReminderBox makeText={single} phone={phone} getBank={getBank} /></section>
  const first = booking.clients?.first_name?.trim()
  return <section aria-label="Payment reminder" className="admin-owed-reminder">
    <p className="admin-detail-hint">{first || 'This client'} owes for {owing.length} bookings · {money(owedTotal(owing))}. One message lists them all and the total.</p>
    <ReminderBox label={owing.length === 2 ? 'Remind about both' : `Remind about all ${owing.length}`} phone={phone} getBank={getBank} makeText={bank => combinedReminderText(owing, bank, first)} />
    <ReminderBox label="Remind about this one only" phone={phone} getBank={getBank} makeText={single} />
  </section>
}
