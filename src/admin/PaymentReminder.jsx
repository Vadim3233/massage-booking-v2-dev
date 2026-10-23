import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import Icon from '../ui/icons.jsx'
import { bankFromSettings, chooseBank, paymentConfig } from '../client/booking/paymentConfig.js'
import { reminderText, whatsappShareLink } from './shareBooking.js'

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

// "Payment reminder", on a booking whose bank transfer is still to come (a client who pays later).
export default function PaymentReminder({ booking, getBank }) {
  return <section aria-label="Payment reminder"><ReminderBox makeText={bank => reminderText(booking, bank)} phone={booking.clients?.phone} getBank={getBank} /></section>
}
