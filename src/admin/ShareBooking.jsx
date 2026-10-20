import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import Icon from '../ui/icons.jsx'
import { bankFromSettings, chooseBank, paymentConfig } from '../client/booking/paymentConfig.js'
import { canShare, shareText, transferDue, whatsappShareLink } from './shareBooking.js'
import { shareMessageApi } from './shareMessageApi.js'

const fallbackBank = paymentConfig(import.meta.env)

// The share button at the top of the booking sheet: WhatsApp the client the booking's details, or share them anywhere (on a computer, copy them). The
// message is made in one place (Copy puts the same text on the clipboard) (shareBooking.js); nothing is ever sent by itself, and it can still be changed in WhatsApp before sending.
export default function ShareBooking({ booking, wordingApi = shareMessageApi }) {
  const [open, setOpen] = useState(false)
  const [bank, setBank] = useState(null)
  const [wording, setWording] = useState(null)
  const [terms, setTerms] = useState(undefined)
  // Until when the client can cancel or move for free (left out of the message if it cannot be read).
  useEffect(() => {
    if (!open || terms !== undefined) return undefined
    let live = true
    supabase.rpc('admin_cancellation_terms', { p_booking_id: booking.id }).then(({ data, error }) => { if (live) setTerms(error ? null : data) }, () => { if (live) setTerms(null) })
    return () => { live = false }
  }, [open, terms, booking.id])
  // The Admin's own wording (Settings › Share message), or the standard one when there is none or it cannot be read.
  useEffect(() => {
    if (!open || wording !== null) return undefined
    let live = true
    wordingApi.get().then(text => { if (live) setWording(text) }, () => { if (live) setWording('') })
    return () => { live = false }
  }, [open, wording, wordingApi])
  const [said, setSaid] = useState('')
  const wrap = useRef(null)
  // The bank details are only needed when a transfer is still due; they are the ones the client's own booking page shows.
  useEffect(() => {
    if (!open || bank || !transferDue(booking)) return undefined
    let live = true
    supabase.rpc('get_bank_details').then(({ data }) => { if (live) setBank(chooseBank(bankFromSettings(data), fallbackBank)) }, () => { if (live) setBank(fallbackBank) })
    return () => { live = false }
  }, [open, bank, booking])
  // A press outside, or Escape, closes the choices.
  useEffect(() => {
    if (!open) return undefined
    const away = event => { if (!wrap.current?.contains(event.target)) setOpen(false) }
    const escape = event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }
    document.addEventListener('pointerdown', away)
    wrap.current?.addEventListener('keydown', escape)
    const node = wrap.current
    return () => { document.removeEventListener('pointerdown', away); node?.removeEventListener('keydown', escape) }
  }, [open])
  if (!canShare(booking)) return null
  const waiting = open && ((transferDue(booking) && !bank) || wording === null || terms === undefined)
  const text = shareText(booking, bank, wording || undefined, terms)
  const whatsapp = whatsappShareLink(booking, text)
  async function share() {
    setSaid('')
    try {
      if (navigator.share) { await navigator.share({ text }); setOpen(false); return }
      await navigator.clipboard.writeText(text)
      setSaid('Copied')
    } catch (failure) {
      if (failure?.name !== 'AbortError') setSaid('Could not share. Try again.')
    }
  }
  // Copy is always there too, for pasting the details anywhere.
  async function copy() {
    setSaid('')
    try { await navigator.clipboard.writeText(text); setSaid('Copied') } catch { setSaid('Could not copy. Try again.') }
  }
  return <div className="admin-share" ref={wrap}>
    <button type="button" className="admin-share-button" aria-label="Share booking details" aria-expanded={open} onClick={() => { setSaid(''); setOpen(value => !value) }}><Icon name="share" size={20} /></button>
    {open && <div className="admin-share-menu">
      {waiting ? <p role="status">Getting the details…</p> : <>
        {whatsapp && <a href={whatsapp} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}><Icon name="chat" size={18} />WhatsApp client</a>}
        <button type="button" onClick={share}><Icon name="share" size={18} />Share…</button>
        <button type="button" onClick={copy}><Icon name="copy" size={18} />Copy</button>
      </>}
      {said && <p role="status">{said}</p>}
    </div>}
  </div>
}
