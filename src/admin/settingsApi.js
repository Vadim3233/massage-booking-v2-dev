import { supabase } from '../lib/supabase.js'

const SAFE = new Set([
  'Enter the name on the account', 'The sort code needs six digits', 'The account number needs eight digits', 'That is too long',
])
const GENERIC = 'Could not save. Please check your connection and try again.'

export function validateBank(details) {
  if (!details.account_name.trim()) return 'Enter the name on the account.'
  if (details.sort_code.replace(/[^0-9]/g, '').length !== 6) return 'The sort code needs six digits, for example 12-34-56.'
  if (details.account_number.replace(/[^0-9]/g, '').length !== 8) return 'The account number needs eight digits.'
  return ''
}

export function createSettingsApi(client) {
  async function call(name, args) {
    const { data, error } = await client.rpc(name, args)
    if (error) throw new Error(SAFE.has(error.message) ? error.message : GENERIC)
    return data
  }
  return {
    bank: () => call('admin_bank_details'),
    saveBank: details => call('admin_save_bank_details', { p_account_name: details.account_name, p_bank_name: details.bank_name || null, p_sort_code: details.sort_code, p_account_number: details.account_number, p_note: details.note || null }),
  }
}
export const settingsApi = createSettingsApi(supabase)
