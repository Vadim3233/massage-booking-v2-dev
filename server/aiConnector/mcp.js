import { createClient } from '@supabase/supabase-js'
import { createTools, INSTRUCTIONS } from './tools.js'

// The connector a client adds to their own AI assistant (Claude, ChatGPT and others that speak the Model Context Protocol). It answers
// JSON-RPC over plain HTTP POST ("streamable HTTP" without a stream: every answer is one JSON reply), and nothing is kept between requests.
//
// Sign-in: an assistant without a token is sent (401 + WWW-Authenticate) to the protected-resource metadata, which names Supabase Auth's OAuth
// server. The client signs in there with their usual account and approves the assistant on /oauth/consent. The token the assistant then sends
// is a normal Supabase token for that client, so every call runs as them, under the same rules as the app.

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const SERVER_INFO = { name: 'vad-massage-booking', title: 'Vad Massage booking', version: '1.0.0' }

export function originOf(request, env = {}) {
  if (env.PUBLIC_SITE_URL) return env.PUBLIC_SITE_URL.replace(/\/$/, '')
  const host = request.headers['x-forwarded-host'] || request.headers.host
  const scheme = request.headers['x-forwarded-proto'] || (/^(localhost|127\.)/.test(host || '') ? 'http' : 'https')
  return host ? `${scheme}://${host}` : ''
}

export function supabaseConfig(env = {}) {
  return { url: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, ''), key: env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || '' }
}

// What an assistant reads to learn where to sign in (RFC 9728).
export function resourceMetadata(origin, env = {}) {
  const { url } = supabaseConfig(env)
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [`${url}/auth/v1`],
    bearer_methods_supported: ['header'],
    resource_name: 'Vad Massage booking',
    resource_documentation: `${origin}/book-with-ai`,
  }
}

const reply = (id, result) => ({ jsonrpc: '2.0', id, result })
const failure = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

function readBody(request) {
  const body = request.body
  if (body && typeof body === 'object') return body
  if (typeof body === 'string') { try { return JSON.parse(body) } catch { return undefined } }
  return undefined
}

// One JSON-RPC message, for a client whose tools are `tools`. Notifications (no id) get nothing back.
export async function answer(message, tools) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return failure(message?.id, -32600, 'Invalid request')
  const { id, method, params = {} } = message
  if (id === undefined || id === null) return null
  if (method === 'initialize') {
    const asked = params.protocolVersion
    return reply(id, {
      protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    })
  }
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: tools.list() })
  if (method === 'tools/call') {
    if (typeof params.name !== 'string') return failure(id, -32602, 'A tool name is needed')
    const outcome = await tools.call(params.name, params.arguments)
    if (outcome.isError) return reply(id, { content: [{ type: 'text', text: outcome.text }], isError: true })
    return reply(id, { content: [{ type: 'text', text: JSON.stringify(outcome.data, null, 2) }], structuredContent: outcome.data, isError: false })
  }
  return failure(id, -32601, `Method not found: ${method}`)
}

function send(response, status, body, headers = {}) {
  response.statusCode = status
  for (const [name, value] of Object.entries({ 'cache-control': 'no-store', ...headers })) response.setHeader(name, value)
  if (body === undefined) { response.end(); return }
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

// The whole request: sign-in check, then one message or a batch. Exported with its pieces replaceable, so it can be tested without a server.
export async function handleMcp(request, response, { env = process.env, makeClient = createClient, makeTools = createTools } = {}) {
  const origin = originOf(request, env)
  response.setHeader('access-control-allow-origin', '*')
  response.setHeader('access-control-expose-headers', 'WWW-Authenticate, Mcp-Session-Id')
  if (request.method === 'OPTIONS') {
    send(response, 204, undefined, { 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id' })
    return
  }
  const { url, key } = supabaseConfig(env)
  if (!url || !key) { send(response, 500, failure(null, -32603, 'The connector is not set up')); return }
  const challenge = error => `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"${error ? `, error="${error}"` : ''}`
  const token = /^Bearer\s+(.+)$/i.exec(request.headers.authorization || '')?.[1]?.trim()
  if (!token) { send(response, 401, failure(null, -32001, 'Sign-in needed'), { 'www-authenticate': challenge() }); return }
  const client = makeClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } })
  const { data, error } = await client.auth.getUser(token)
  if (error || !data?.user) { send(response, 401, failure(null, -32001, 'Sign-in expired'), { 'www-authenticate': challenge('invalid_token') }); return }
  // A guest's session is not an account: the assistant has to sign in with a real one.
  if (data.user.is_anonymous) { send(response, 401, failure(null, -32001, 'Sign in with a Vad Massage account'), { 'www-authenticate': challenge('invalid_token') }); return }
  // No stream of server messages is offered; everything is an answer to a POST.
  if (request.method !== 'POST') { send(response, 405, failure(null, -32000, 'Use POST'), { allow: 'POST' }); return }
  const body = readBody(request)
  if (body === undefined) { send(response, 400, failure(null, -32700, 'Parse error')); return }
  const tools = makeTools({ client, userId: data.user.id, origin, env })
  if (Array.isArray(body)) {
    const answers = (await Promise.all(body.map(message => answer(message, tools)))).filter(Boolean)
    if (answers.length) send(response, 200, answers)
    else send(response, 202)
    return
  }
  const single = await answer(body, tools)
  if (single) send(response, 200, single)
  else send(response, 202)
}
