import { supabase } from '../lib/supabase.js'
import { whatsappNumber } from './contactLinks.js'

const SAFE_MESSAGES = new Set(['Please check the WhatsApp number', 'Add your WhatsApp number to show the button'])
const failure = error => new Error(SAFE_MESSAGES.has(error?.message) ? error.message : 'Could not save. Please check your connection and try again.')

// A UK number typed as 07… becomes 447…, the form wa.me needs. Empty is allowed only with the button hidden.
export function checkWhatsApp({ number, show }) {
  const digits = whatsappNumber(number) || ''
  if (!digits) return { digits: '', problem: show ? 'Add your WhatsApp number to show the button.' : '' }
  if (!/^\d{8,15}$/.test(digits)) return { digits, problem: 'Please check the number: a UK mobile has 11 digits and starts with 07.' }
  if (digits.startsWith('44') && digits.length !== 12) return { digits, problem: 'Please check the number: a UK mobile has 11 digits and starts with 07.' }
  return { digits, problem: '' }
}

export function createWhatsAppApi(client) {
  return {
    async get() {
      const { data, error } = await client.from('business_settings').select('value').eq('key', 'whatsapp_button').maybeSingle()
      if (error) throw new Error('Could not load. Please check your connection and try again.')
      return { number: typeof data?.value?.number === 'string' ? data.value.number : '', show: data?.value?.show === true }
    },
    async save({ number, show }) {
      const { error } = await client.rpc('admin_save_whatsapp', { p_number: number, p_show: show })
      if (error) throw failure(error)
    },
  }
}
export const whatsappApi = createWhatsAppApi(supabase)
