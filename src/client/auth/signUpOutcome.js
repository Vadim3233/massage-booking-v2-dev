// What a sign-up call actually did, so the page says the right thing.
//  - 'signed-in': the account is ready and a session came back (confirmation is switched off).
//  - 'already-registered': with "Confirm email" on, Supabase answers an email that already has an account with a made-up user
//    that has no identities, and sends nothing, so the page must not tell her to check her email.
//  - 'confirm-email': a new account that has to be confirmed from the link in the email first.
export function signUpOutcome(data) {
  if (data?.session) return 'signed-in'
  if (Array.isArray(data?.user?.identities) && data.user.identities.length === 0) return 'already-registered'
  return 'confirm-email'
}
