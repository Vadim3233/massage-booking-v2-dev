import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

// Asking the client before anything that changes a booking, in a way that works for every assistant and keeps the connector stateless.
//
// - An app that can show a confirmation card (MCP 2026-07-28 with elicitation): the tool answers "input required" with a Yes / No card, and the
//   app sends the same call again with the client's answer and the signed state it was given (multi round-trip requests).
// - Any other assistant: the first call returns a preview and a one-time confirmation code. The assistant must show the preview and get a yes,
//   then call again with the code.
//
// Both the state and the code are signed (HMAC) and say who, which tool, exactly which details (and fee or total) and until when. Using one again
// is harmless: the request id the database is given comes from the code, so the same change is never made twice.

export const CONFIRM_MINUTES = 15
export const CONFIRM_KEY = 'confirm'

export function confirmSecret(env = {}) {
  if (env.MCP_CONFIRM_SECRET) return env.MCP_CONFIRM_SECRET
  // Derived, never the key itself: the service key is on the server already and never leaves it.
  if (env.SUPABASE_SERVICE_ROLE_KEY) return createHmac('sha256', env.SUPABASE_SERVICE_ROLE_KEY).update('vad-mcp-confirm-v1').digest('hex')
  return ''
}

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const decode = text => { try { return JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) } catch { return null } }

// What a confirmation is bound to: the tool and its details (without the code itself), so a code for one change cannot confirm another.
export function digestOf(tool, details) {
  const sorted = Object.fromEntries(Object.entries(details || {}).filter(([key, value]) => key !== 'confirmation_code' && value !== undefined).sort(([a], [b]) => a.localeCompare(b)))
  return createHash('sha256').update(JSON.stringify([tool, sorted])).digest('base64url').slice(0, 32)
}

export function createConfirmer({ secret, userId, now = () => new Date() }) {
  const mac = body => createHmac('sha256', secret).update(body).digest('base64url')
  return {
    available: Boolean(secret),
    sign(tool, details, amount) {
      const body = encode({ u: userId, t: tool, d: digestOf(tool, details), a: amount ?? null, x: now().getTime() + CONFIRM_MINUTES * 60_000 })
      return `${body}.${mac(body)}`
    },
    // 'ok', 'expired', 'changed' (the amount moved since the preview) or 'invalid'.
    check(code, tool, details, amount) {
      if (!secret || typeof code !== 'string' || !code.includes('.')) return 'invalid'
      const [body, signature] = code.split('.')
      const expected = Buffer.from(mac(body))
      const given = Buffer.from(String(signature))
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid'
      const claim = decode(body)
      if (!claim || claim.u !== userId || claim.t !== tool || claim.d !== digestOf(tool, details)) return 'invalid'
      if (claim.x < now().getTime()) return 'expired'
      if ((claim.a ?? null) !== (amount ?? null)) return 'changed'
      return 'ok'
    },
    // A request id for the database, the same every time this code is used.
    requestId(code) {
      const hex = createHash('sha256').update(String(code)).digest('hex')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
    },
  }
}

// Whether the client's app said it can show a confirmation card (form elicitation). An empty elicitation object means form.
export function canShowCard(clientCapabilities) {
  const elicitation = clientCapabilities?.elicitation
  if (!elicitation || typeof elicitation !== 'object') return false
  return Object.keys(elicitation).length === 0 || Boolean(elicitation.form)
}

// The card itself: a message and one Yes switch.
export function cardRequest(message, yesLabel) {
  return {
    [CONFIRM_KEY]: {
      method: 'elicitation/create',
      params: {
        mode: 'form', message,
        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: yesLabel, default: false } }, required: ['confirm'] },
      },
    },
  }
}

// What the client answered on the card: 'yes', 'no', or null when there is no answer yet.
export function cardAnswer(inputResponses) {
  const response = inputResponses?.[CONFIRM_KEY]
  if (!response) return null
  return response.action === 'accept' && response.content?.confirm === true ? 'yes' : 'no'
}
