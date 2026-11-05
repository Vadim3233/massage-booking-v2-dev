import { describe, expect, it, vi } from 'vitest'
import { browserStorage, ensureHoldSession, forgetQuietGuest, isQuietGuest, rememberQuietGuest } from './quietGuest.js'

const memory = () => { const data = new Map(); return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) } }
const anonymous = (id) => ({ user: { id, is_anonymous: true } })
function client({ session = null, signedInId = 'quiet-1', signInError = null } = {}) {
  return { auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    signInAnonymously: vi.fn().mockResolvedValue(signInError ? { data: {}, error: signInError }
      : { data: { user: { id: signedInId, is_anonymous: true }, session: signedInId ? anonymous(signedInId) : null }, error: null }),
  } }
}

describe('quiet guest session for holding a time', () => {
  it('starts a guest session when there is none, and remembers it as quiet', async () => {
    const storage = memory(); const c = client()
    expect(await ensureHoldSession(c, storage)).toBe('quiet-1')
    expect(c.auth.signInAnonymously).toHaveBeenCalledTimes(1)
    expect(isQuietGuest(storage, anonymous('quiet-1'))).toBe(true)
  })
  it('keeps any existing session as it is and never marks it quiet', async () => {
    for (const session of [{ user: { id: 'account', is_anonymous: false } }, anonymous('chosen-guest')]) {
      const storage = memory(); const c = client({ session })
      expect(await ensureHoldSession(c, storage)).toBe(session.user.id)
      expect(c.auth.signInAnonymously).not.toHaveBeenCalled()
      expect(isQuietGuest(storage, session)).toBe(false)
    }
  })
  it('passes on a refused guest session (for example the rate limit) without remembering anything', async () => {
    const storage = memory(); const c = client({ signInError: Object.assign(new Error('Request rate limit reached'), { status: 429 }) })
    await expect(ensureHoldSession(c, storage)).rejects.toThrow(/rate limit/)
    expect(storage.getItem('vm-quiet-guest')).toBeNull()
  })
  it('refuses to carry on when the guest sign-in came back without a session', async () => {
    const storage = memory(); const c = client({ signedInId: null })
    await expect(ensureHoldSession(c, storage)).rejects.toThrow(/Please try again/)
    expect(storage.getItem('vm-quiet-guest')).toBeNull()
  })
  it('only the remembered anonymous session is quiet; an account with the same id or another guest is not', () => {
    const storage = memory(); rememberQuietGuest(storage, 'quiet-1')
    expect(isQuietGuest(storage, { user: { id: 'quiet-1', is_anonymous: false } })).toBe(false)
    expect(isQuietGuest(storage, anonymous('someone-else'))).toBe(false)
    expect(isQuietGuest(storage, null)).toBe(false)
    forgetQuietGuest(storage)
    expect(isQuietGuest(storage, anonymous('quiet-1'))).toBe(false)
  })
  it('gives no storage, instead of crashing, where the browser blocks site storage', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('SecurityError') } })
    try {
      expect(browserStorage()).toBeNull()
      expect(isQuietGuest(browserStorage(), anonymous('quiet-1'))).toBe(false)
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage
    }
  })
  it('works without storage: the visitor is then treated as a guest who already chose', async () => {
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } }
    expect(await ensureHoldSession(client(), broken)).toBe('quiet-1')
    expect(isQuietGuest(broken, anonymous('quiet-1'))).toBe(false)
    expect(() => forgetQuietGuest(broken)).not.toThrow()
  })
})
