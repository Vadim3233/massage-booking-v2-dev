import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { dateLabel, timeLabel } from './booking/bookingDraft.js'

// The "WhatsApp me" button (ADR-109): Vadim's number, only while he has the button switched on in More › WhatsApp button.
// Nothing is shown until the number arrives, and nothing at all if it is off or the setting is missing.
export function useWhatsApp(client = supabase) {
  const [number, setNumber] = useState(null)
  useEffect(() => {
    let live = true
    client.rpc('get_public_whatsapp').then(({ data, error }) => { if (live && !error && typeof data === 'string' && /^\d{8,15}$/.test(data)) setNumber(data) }, () => {})
    return () => { live = false }
  }, [client])
  return number
}

export const whatsappLink = (number, text) => `https://wa.me/${number}${text ? `?text=${encodeURIComponent(text)}` : ''}`

export const WHATSAPP_HELLO = {
  booking: 'Hi Vadim, I have a question about booking a massage.',
  faq: 'Hi Vadim, I have a question.',
}

// Names the appointment (day, time and reference) so Vadim knows straight away which booking the message is about.
export function appointmentHello(booking) {
  const when = booking?.date && Number.isFinite(booking?.start_minutes) ? ` on ${dateLabel(booking.date)} at ${timeLabel(booking.start_minutes)}` : ''
  const reference = booking?.booking_reference ? ` (${booking.booking_reference})` : ''
  return `Hi Vadim, it's about my appointment${when}${reference}.`
}
