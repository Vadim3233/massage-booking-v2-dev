import { GENERIC } from '../booking/friendlyError.js'

// What the sign-in service says, in the words a client would use. Anything else stays out of sight.
const AUTH_MESSAGES = [
  [/invalid login credentials/i, "That email and password don't match. Please check them and try again."],
  [/already registered|already been registered/i, "There is already an account with that email. Please try signing in instead."],
  [/email not confirmed/i, 'Please confirm your email first. The link is in the message I sent you.'],
  [/different from the old password|same as the old password/i, 'Please choose a password that is different from your old one.'],
  [/password should be at least|password.*(short|weak)|least 8/i, 'Please choose a password of at least 8 characters.'],
  [/rate limit|too many/i, 'That has been tried a few times. Please wait a minute and try again.'],
]

export const authMessage = (error) => AUTH_MESSAGES.find(([pattern]) => pattern.test(error?.message || ''))?.[1] || GENERIC
