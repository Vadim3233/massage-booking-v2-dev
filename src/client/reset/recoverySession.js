import { supabase } from '../../lib/supabase.js'

// The page that asks a client for a new password after the link in a reset email (/reset-password). It is built like the Admin's own reset page:
// the form is only for a session that the link itself made, never for someone who is simply signed in, so it can be opened only from the link.
const KEY = 'client-password-recovery-session'
const onResetPage = window.location.pathname.replace(/\/$/, '') === '/reset-password'
const fragment = new URLSearchParams(window.location.hash.slice(1))
const query = new URLSearchParams(window.location.search)
// A link that was used already, or has run out, comes back with the reason in its address.
export const linkHasError = ['error', 'error_code'].some((name) => fragment.has(name) || query.has(name))
// A fresh link carries its secret in the address; the sign-in library takes it out and keeps the session.
export const linkHasSecret = fragment.has('access_token') || query.has('code')

// Subscribe before the page loads, because the library announces a recovery only once, as soon as it has read the link. Only the id of the
// session is kept (for this tab), never a token or a password.
if (supabase && onResetPage) {
  // A second link opened in the same tab may only change the part after the #: start over, so that link is checked on its own.
  window.addEventListener('hashchange', () => {
    const params = new URLSearchParams(window.location.hash.slice(1))
    if (['access_token', 'error', 'error_code'].some((name) => params.has(name))) window.location.reload()
  })
  try {
    // A new link makes its own session, so a marker from an earlier one is never reused.
    if (linkHasSecret || linkHasError) sessionStorage.removeItem(KEY)
  } catch { /* Without storage the check below simply fails, and the page offers a new link. */ }
  supabase.auth.onAuthStateChange((event, session) => {
    try {
      if (event === 'PASSWORD_RECOVERY' && session && !linkHasError) {
        const payload = JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
        sessionStorage.setItem(KEY, payload.session_id)
      } else if (event === 'SIGNED_OUT') sessionStorage.removeItem(KEY)
    } catch { /* Storage unavailable: the check below fails, and the page offers a new link. */ }
  })
}

// Whether the person on this page arrived by a reset link and is still in the session that link made.
export async function recoverySession() {
  const { data, error } = await supabase.auth.getClaims()
  // getClaims checks the token; the marker only says the session came from the link. The sign-in service still decides whether a password may change.
  if (error || !data?.claims?.session_id || data.claims.session_id !== sessionStorage.getItem(KEY)) return false
  const result = await supabase.auth.getUser()
  return !result.error && !!result.data.user && !result.data.user.is_anonymous
}

// Once the password is saved the link's session is just an ordinary signed-in session, and the form must not be usable again.
export function forgetRecovery() {
  try { sessionStorage.removeItem(KEY) } catch { /* Nothing to forget. */ }
}
