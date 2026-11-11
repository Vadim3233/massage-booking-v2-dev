import { supabase } from '../lib/supabase.js'

// More › Family alerts: who in the family gets a Telegram message about new, moved and cancelled bookings, a one-time link to add someone,
// and switching a chat off. All three are database functions for the Admin only.
const plain = message => new Error(message)
const missing = error => error?.code === 'PGRST202' || /family_telegram/.test(error?.message || '')

export function createFamilyAlertsApi(client) {
  return {
    status: async () => {
      const { data, error } = await client.rpc('admin_family_telegram_status')
      if (error) throw plain(missing(error) ? 'Family alerts need a database update first.' : 'Could not load family alerts. Please try again.')
      return Array.isArray(data?.chats) ? data.chats : []
    },
    createLink: async () => {
      const { data, error } = await client.rpc('admin_create_family_telegram_link')
      if (error) throw plain(error.message === 'Please wait a little before asking again.' ? error.message : 'Could not make the link. Please try again.')
      return data
    },
    stop: async id => {
      const { error } = await client.rpc('admin_stop_family_telegram', { p_id: id })
      if (error) throw plain('Could not switch it off. Please try again.')
    },
  }
}

export const familyAlertsApi = createFamilyAlertsApi(supabase)

// The words sent with the link (in Spanish, like the alerts), and a WhatsApp link that lets the Admin pick who to send them to.
export function familyInviteMessage(link) {
  return `¡Hola mi amor! 💛 Toca este enlace y pulsa Start (Iniciar) en Telegram para recibir un aviso cuando tenga una reserva nueva, o cuando una cambie o se cancele, y saber a qué hora estaré en casa 🏠:\n${link}\n\nEl enlace funciona una sola vez, durante 24 horas. 😘`
}
export const familyInviteWhatsappLink = text => `https://wa.me/?text=${encodeURIComponent(text)}`
