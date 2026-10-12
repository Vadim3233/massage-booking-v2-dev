// A quick check, before the Admin's screens load, that the signed-in person really is the Admin, so a wrong account
// gets a clear sentence instead of an empty page. The database enforces access on every read and command regardless.
// The answer is remembered for a few minutes per person: it saves two network round trips on every screen.
const REMEMBER_MS = 5 * 60 * 1000

export function createAdminGate(client, { signedOut, denied }) {
  let remembered = null
  return async function authorized() {
    const { data } = await client.auth.getSession()
    const user = data?.session?.user
    if (!user || user.is_anonymous) { remembered = null; throw new Error(signedOut) }
    if (remembered?.userId === user.id && remembered.until > Date.now()) return remembered.check
    const check = Promise.resolve(client.rpc('is_booking_admin')).then(result => { if (result.error || !result.data) throw new Error(denied) })
    remembered = { userId: user.id, until: Date.now() + REMEMBER_MS, check }
    check.catch(() => { if (remembered?.check === check) remembered = null })
    return check
  }
}
