import { describe, expect, it, vi } from 'vitest'
import { createAuthApi } from './authApi'

function fakeClient(overrides = {}) {
  const subscription = { unsubscribe: vi.fn() }
  const auth = {
    getSession: vi.fn(async () => ({ data: { session: { user: { id: 'u1' } } }, error: null })),
    onAuthStateChange: vi.fn((callback) => {
      callback('SIGNED_IN', { user: { id: 'u1' } })
      return { data: { subscription } }
    }),
    signInAnonymously: vi.fn(async () => ({ data: { session: { user: { is_anonymous: true } } }, error: null })),
    signInWithPassword: vi.fn(async (params) => ({ data: params, error: null })),
    signUp: vi.fn(async (params) => ({ data: { session: null, params }, error: null })),
    resetPasswordForEmail: vi.fn(async (email, options) => ({ data: { email, options }, error: null })),
    updateUser: vi.fn(async (params) => ({ data: params, error: null })),
    ...overrides,
  }
  return { client: { auth }, auth, subscription }
}

describe('auth API boundary', () => {
  it('returns session data without exposing Supabase response envelopes', async () => {
    const { client } = fakeClient()
    await expect(createAuthApi(client).getSession()).resolves.toEqual({ session: { user: { id: 'u1' } } })
  })

  it('maps registration fields to the Supabase auth contract', async () => {
    const { client, auth } = fakeClient()
    const api = createAuthApi(client)

    await api.signUp({
      email: 'client@example.test',
      password: 'password123',
      redirectTo: 'https://example.test/?step=5',
      firstName: 'Test',
      lastName: 'Client',
    })

    expect(auth.signUp).toHaveBeenCalledWith({
      email: 'client@example.test',
      password: 'password123',
      options: {
        emailRedirectTo: 'https://example.test/?step=5',
        data: {
          first_name: 'Test',
          last_name: 'Client',
        },
      },
    })
  })

  it('normalizes password reset and recovery operations', async () => {
    const { client, auth } = fakeClient()
    const api = createAuthApi(client)

    await api.resetPasswordForEmail({
      email: 'client@example.test',
      redirectTo: 'https://example.test/?step=5',
    })
    await api.updatePassword('new-password')

    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith(
      'client@example.test',
      { redirectTo: 'https://example.test/?step=5' }
    )
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'new-password' })
  })

  it('returns an unsubscribe function for auth subscriptions', () => {
    const { client, subscription } = fakeClient()
    const unsubscribe = createAuthApi(client).onAuthStateChange(() => {})
    unsubscribe()
    expect(subscription.unsubscribe).toHaveBeenCalledOnce()
  })

  it('throws auth errors instead of leaking response handling to React', async () => {
    const error = new Error('Invalid credentials')
    const { client } = fakeClient({
      signInWithPassword: vi.fn(async () => ({ data: null, error })),
    })

    await expect(
      createAuthApi(client).signInWithPassword({
        email: 'client@example.test',
        password: 'wrong',
      })
    ).rejects.toThrow('Invalid credentials')
  })
})
