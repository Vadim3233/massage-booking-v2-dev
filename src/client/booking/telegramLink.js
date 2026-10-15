// The clients-only Telegram bot, from the page's side. Its public username comes from a site setting (VITE_TELEGRAM_CLIENT_BOT_USERNAME); the
// button opens the bot with a one-time code (https://t.me/<bot>?start=<code>), and pressing Start in Telegram links that chat to the booking's client.

// Telegram bot usernames are 5 to 32 letters, digits and underscores, start with a letter and end in "bot". A setting that is anything else
// (empty, a typo, a link) means the bot is not set up, and the box is not shown.
const USERNAME = /^[A-Za-z][A-Za-z0-9_]{1,28}[Bb][Oo][Tt]$/
// A code is what the database made: 32 letters and digits. Telegram only allows letters, digits, _ and - in it, up to 64 characters.
const CODE = /^[A-Za-z0-9_-]{16,64}$/

export function cleanUsername(value) {
  const name = String(value ?? '').trim().replace(/^@/, '')
  return USERNAME.test(name) ? name : ''
}

export function telegramLink(username, code) {
  const name = cleanUsername(username)
  return name && typeof code === 'string' && CODE.test(code) ? `https://t.me/${name}?start=${code}` : ''
}

// A code lasts two hours. One an hour old is replaced the next time the page is looked at, so a button left open on a phone still works.
export const REFRESH_AFTER_MS = 60 * 60 * 1000
export const shouldRefresh = (mintedAt, now) => !Number.isFinite(mintedAt) || now - mintedAt >= REFRESH_AFTER_MS
// While waiting for the client to press Start in Telegram, the page looks every few seconds, for a few minutes.
export const POLL_MS = 3000
export const POLL_FOR_MS = 5 * 60 * 1000
