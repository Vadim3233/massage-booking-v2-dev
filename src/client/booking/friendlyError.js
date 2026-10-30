// What a client may read when something goes wrong. The database writes a few sentences for them (the ones that say what to
// do, such as "Please choose a later time"); everything else is about the connection or the system and stays out of sight.
export const GENERIC = 'Something went wrong. Please try again, or contact Vad if it keeps happening.'

const TIME_TAKEN = 'Sorry, that time has just been taken. Please choose another; your details are saved.'

// Sentences that are accurate but written for a developer, with the plain version to show instead.
const REWRITES = [
  [/no longer available|^booking unavailable$|time is not available|time slot/i, TIME_TAKEN],
  [/hold (identity|token)|hold was not found|hold has expired|released/i, 'Your time was released. Please choose a time again.'],
  [/client account is not activated|authentication required/i, 'Please sign in or continue as a guest to carry on.'],
  [/online booking is disabled/i, "Online booking isn't available on this account just now. Please get in touch and I'll arrange your appointment."],
  [/already in progress|command in progress/i, 'That is still being saved. Please wait a moment and try again.'],
  [/failed to fetch|network|load failed|timeout/i, 'The connection dropped. Please check it and try again.'],
]

// Messages the database writes for the app's own checks, not for clients: about keys, IDs, fields and data shapes. They are never shown,
// even when they carry the code clients' own messages use.
const TECHNICAL = /\b(ID|key|keys|token|idempotency|jsonb?|array|object|scalar|null|argument|arguments|parameter|payload|identity|constraint|relation|column)\b|is invalid\.?$|must be provided|unsupported|duplicates|travel buffer|[a-z]+_[a-z_]+/i

export function friendlyError(error, fallback = GENERIC) {
  const message = typeof error === 'string' ? error : error?.message || ''
  if (!message) return fallback
  const rewrite = REWRITES.find(([pattern]) => pattern.test(message))
  if (rewrite) return rewrite[1]
  // The server's own advice to a client always asks them to do something ("Please ...").
  if (TECHNICAL.test(message)) return fallback
  if (error?.code === '22023' || /\bPlease\b/.test(message)) return message
  return fallback
}
