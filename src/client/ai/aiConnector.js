// What the "Book with AI" pages say, kept in one place so the consent page and the help page say the same.

// The connector's address: this site with /mcp.
export const connectorUrl = (origin = window.location.origin) => `${origin}/mcp`

export const WHAT_IT_CAN_DO = [
  'See treatments, prices and my free times',
  'See your saved addresses and your bookings',
  'Book an appointment for you, or for you and one other person, after you say yes',
  'Tell me when you have sent a bank transfer',
  'Add your appointment to your calendar and connect Telegram updates',
]

// The steps for each assistant. Others that support MCP connectors work the same way: add a connector with the address, then sign in.
export const ASSISTANT_STEPS = [
  { name: 'Claude', steps: ['Open Claude in a browser or the desktop app, and go to Settings, then Connectors.', 'Choose Add custom connector, name it VadMassage, and paste the address.', 'Press Connect, sign in with your VadMassage account and press Allow.'] },
  { name: 'ChatGPT', steps: ['In ChatGPT, go to Settings, then Apps & Connectors (custom connectors may need developer mode, or a paid plan).', 'Create a connector, name it VadMassage, and paste the address.', 'Sign in with your VadMassage account and press Allow.'] },
]

// Where an assistant sends the client back to after Allow. Anyone can register an assistant and give it any name, so the name proves
// nothing; the address it returns to does. Only these are offered Allow (ADR-085): Claude, ChatGPT, Google Gemini, and an assistant
// running on the client's own computer (its address is on that computer, so nobody else can receive the sign-in).
const KNOWN_ASSISTANTS = [
  { name: 'Claude', hosts: ['claude.ai', 'claude.com'] },
  { name: 'ChatGPT', hosts: ['chatgpt.com', 'chat.openai.com'] },
  { name: 'Google Gemini', pattern: /^oauth-redirect(-[a-z0-9]+)?\.googleusercontent\.com$/ },
]
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']

export function assistantDestination(redirectUri) {
  let url
  try { url = new URL(redirectUri) } catch { return { host: '', known: false } }
  const host = url.hostname.toLowerCase()
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (LOOPBACK.includes(host)) return { host, known: true, label: 'the assistant on this computer' }
    if (url.protocol === 'https:') {
      const match = KNOWN_ASSISTANTS.find(item => item.hosts?.includes(host) || item.pattern?.test(host))
      if (match) return { host, known: true, label: `${match.name} (${host})` }
    }
  }
  return { host: url.protocol === 'http:' || url.protocol === 'https:' ? host : `${url.protocol}//${host}`, known: false }
}

export const EXAMPLE_ASKS = ['Book me with Vad next Tuesday evening, 60 minutes.', 'Same as last time, sometime next week.', 'Book a couples massage for me and Sam, 90 minutes each, this weekend.', "I've paid for my booking."]
