import { supabase } from '../lib/supabase.js'

export const WELCOME_LIMIT = 500
export const ABOUT_LIMIT = 1500
const SAFE_MESSAGES = new Set(['The welcome message can be up to 500 characters', 'The about text can be up to 1500 characters'])
const failure = error => new Error(SAFE_MESSAGES.has(error?.message) ? error.message : 'Could not save. Please check your connection and try again.')

export function validateWelcome({ welcome, about }) {
  if (welcome.trim().length > WELCOME_LIMIT) return `The welcome can be up to ${WELCOME_LIMIT} characters.`
  if (about.trim().length > ABOUT_LIMIT) return `The about text can be up to ${ABOUT_LIMIT} characters.`
  return ''
}

export function createWelcomeApi(client) {
  async function run(request) {
    const { data, error } = await request
    if (error) throw failure(error)
    return data
  }
  return {
    get: () => run(client.rpc('get_public_welcome')),
    save: ({ welcome, about }) => run(client.rpc('admin_save_welcome', { p_welcome: welcome.trim() || null, p_about: about.trim() || null })),
  }
}
export const welcomeApi = createWelcomeApi(supabase)
