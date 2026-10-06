import { supabase } from '../lib/supabase.js'

const key = 'admin-password-recovery-session'
const resetPath = window.location.pathname.replace(/\/$/, '') === '/admin/reset-password'
const fragment = new URLSearchParams(window.location.hash.slice(1))
const query = new URLSearchParams(window.location.search)
export const recoveryLinkError = ['error', 'error_code'].some(name => fragment.has(name) || query.has(name))

// Subscribe before lazy route loading so the SDK's one-time recovery event
// cannot be missed. Store only a non-secret session ID, never a token/password.
if (supabase && resetPath) {
  // Following a second email link in this tab may be a fragment-only navigation.
  // Reinitialize the SDK so that link is verified instead of retaining the form.
  window.addEventListener('hashchange', () => {
    const params = new URLSearchParams(window.location.hash.slice(1))
    if (['access_token', 'error', 'error_code'].some(name => params.has(name))) window.location.reload()
  })
  // A new link must establish its own recovery session; never reuse a marker.
  try {
    if (fragment.has('access_token') || query.has('code') || recoveryLinkError) sessionStorage.removeItem(key)
  } catch { /* The session check below fails closed. */ }
  supabase.auth.onAuthStateChange((event, session) => {
    try {
      if (event === 'PASSWORD_RECOVERY' && session && !recoveryLinkError) {
        const payload = JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
        sessionStorage.setItem(key, payload.session_id)
      } else if (event === 'SIGNED_OUT') sessionStorage.removeItem(key)
    } catch { /* Storage unavailable: fail closed when checking recovery. */ }
  })
}

export async function recoverySession() {
  const { data, error } = await supabase.auth.getClaims()
  // getClaims validates the JWT; the marker is only recovery UI provenance.
  // Supabase Auth still authorizes updateUser, and admin_users governs access.
  if (error || !data?.claims?.session_id || data.claims.session_id !== sessionStorage.getItem(key)) return false
  const result = await supabase.auth.getUser()
  return !result.error && !!result.data.user && !result.data.user.is_anonymous
}
