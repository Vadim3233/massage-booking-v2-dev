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

export const EXAMPLE_ASKS = ['Book me with Vad next Tuesday evening, 60 minutes.', 'Same as last time, sometime next week.', 'Book a couples massage for me and Sam, 90 minutes each, this weekend.', "I've paid for my booking."]
