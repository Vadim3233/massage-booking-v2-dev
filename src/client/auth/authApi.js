async function authResult(request) {
  const { data, error } = await request
  if (error) throw error
  return data
}

export function createAuthApi(client) {
  return {
    getSession: () => authResult(client.auth.getSession()),
    onAuthStateChange(callback) {
      const { data } = client.auth.onAuthStateChange(callback)
      return () => data.subscription.unsubscribe()
    },
    signInAnonymously: () => authResult(client.auth.signInAnonymously()),
    signInWithPassword: ({ email, password }) =>
      authResult(client.auth.signInWithPassword({ email, password })),
    signUp: ({ email, password, redirectTo, firstName, lastName }) =>
      authResult(client.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: redirectTo,
          data: {
            first_name: firstName,
            last_name: lastName,
          },
        },
      })),
    resetPasswordForEmail: ({ email, redirectTo }) =>
      authResult(client.auth.resetPasswordForEmail(email, { redirectTo })),
    updatePassword: (password) =>
      authResult(client.auth.updateUser({ password })),
  }
}
