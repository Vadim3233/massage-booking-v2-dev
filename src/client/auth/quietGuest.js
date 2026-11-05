// Holding a time needs a session (the database refuses holds without one, so nobody can hold the whole calendar from a script).
// A visitor who has not yet chosen "continue as guest" or signed in gets a guest session started quietly, just before their first hold.
// Its id is remembered here so the rest of the app keeps treating that visitor exactly as before: as not yet signed in, with the
// guest-or-account choice still to come on the details screen.
const KEY = 'vm-quiet-guest'

// The browser's storage, or null where site storage is blocked (just reading window.localStorage throws there).
export function browserStorage() {
  try { return globalThis.localStorage ?? null } catch { return null }
}

function read(storage) {
  try { return storage?.getItem(KEY) || null } catch { return null }
}

export function rememberQuietGuest(storage, userId) {
  try { storage?.setItem(KEY, userId) } catch { /* Without storage the visitor is simply treated as a guest who already chose. */ }
}

export function forgetQuietGuest(storage) {
  try { storage?.removeItem(KEY) } catch { /* Nothing to forget. */ }
}

// True only for the guest session this page started by itself. A guest the visitor chose, or any account, is never quiet.
export function isQuietGuest(storage, session) {
  const user = session?.user
  return Boolean(user?.is_anonymous && user.id && read(storage) === user.id)
}

// Makes sure there is a session before a hold. An existing session (account, chosen guest or quiet guest) is kept as it is.
export async function ensureHoldSession(client, storage) {
  const { data, error } = await client.auth.getSession()
  if (error) throw error
  if (data?.session?.user?.id) return data.session.user.id
  const { data: signedIn, error: signInError } = await client.auth.signInAnonymously()
  if (signInError) throw signInError
  const userId = signedIn?.session?.user?.id
  if (!userId) throw new Error('Unable to start a session. Please try again.')
  rememberQuietGuest(storage, userId)
  return userId
}
