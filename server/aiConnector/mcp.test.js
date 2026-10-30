import { describe, expect, it, vi } from 'vitest'
import { answer, handleMcp, originOf, resourceMetadata } from './mcp.js'

const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon' }

function exchange(request, options) {
  const response = { statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name.toLowerCase()] = value }, end(body = '') { this.body = body } }
  return handleMcp({ method: 'POST', headers: { host: 'book.example.com' }, ...request }, response, options).then(() => ({ ...response, json: response.body ? JSON.parse(response.body) : null }))
}
const signedIn = (user = { id: 'user-1' }) => () => ({ auth: { getUser: async () => ({ data: { user }, error: null }) } })
const fakeTools = { list: () => [{ name: 'ping_tool' }], call: vi.fn(async name => name === 'bad' ? { isError: true, text: 'No.' } : { isError: false, data: { ok: true } }) }

describe('the connector at /mcp', () => {
  it('sends an assistant without a token to sign in, naming where', async () => {
    const result = await exchange({ body: { jsonrpc: '2.0', id: 1, method: 'initialize' } }, { env })
    expect(result.statusCode).toBe(401)
    expect(result.headers['www-authenticate']).toBe('Bearer resource_metadata="https://book.example.com/.well-known/oauth-protected-resource/mcp"')
  })
  it('refuses a token that is not a sign-in, and a guest session', async () => {
    const bad = await exchange({ headers: { host: 'book.example.com', authorization: 'Bearer nope' }, body: {} }, { env, makeClient: () => ({ auth: { getUser: async () => ({ data: null, error: new Error('bad') }) } }) })
    expect(bad.statusCode).toBe(401)
    expect(bad.headers['www-authenticate']).toMatch(/error="invalid_token"/)
    const guest = await exchange({ headers: { host: 'book.example.com', authorization: 'Bearer t' }, body: {} }, { env, makeClient: signedIn({ id: 'g', is_anonymous: true }) })
    expect(guest.statusCode).toBe(401)
  })
  it('answers as the signed-in client, gives notifications no reply, and answers a batch', async () => {
    const makeTools = vi.fn(() => fakeTools)
    const options = { env, makeClient: signedIn(), makeTools }
    const headers = { host: 'book.example.com', authorization: 'Bearer token' }
    const init = await exchange({ headers, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } } }, options)
    expect(init.statusCode).toBe(200)
    expect(init.json.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'vad-massage-booking' } })
    expect(makeTools.mock.calls[0][0]).toMatchObject({ userId: 'user-1', origin: 'https://book.example.com' })
    const note = await exchange({ headers, body: { jsonrpc: '2.0', method: 'notifications/initialized' } }, options)
    expect(note.statusCode).toBe(202)
    const batch = await exchange({ headers, body: [{ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bad' } }] }, options)
    expect(batch.json).toEqual([
      { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'ping_tool' }] } },
      { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'No.' }], isError: true } },
    ])
  })
  it('only takes POST once signed in', async () => {
    const result = await exchange({ method: 'GET', headers: { host: 'book.example.com', authorization: 'Bearer t' } }, { env, makeClient: signedIn(), makeTools: () => fakeTools })
    expect(result.statusCode).toBe(405)
  })
})

describe('one message', () => {
  it('offers the newest protocol when asked for one it does not know, and says what is not there', async () => {
    expect((await answer({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, fakeTools)).result.protocolVersion).toBe('2025-06-18')
    expect((await answer({ jsonrpc: '2.0', id: 1, method: 'resources/list' }, fakeTools)).error.code).toBe(-32601)
    expect((await answer({ id: 1 }, fakeTools)).error.code).toBe(-32600)
  })
  it('gives a tool result as text and as structured content', async () => {
    expect((await answer({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'good', arguments: {} } }, fakeTools)).result)
      .toEqual({ content: [{ type: 'text', text: '{\n  "ok": true\n}' }], structuredContent: { ok: true }, isError: false })
  })
})

describe('where to sign in', () => {
  it('names Supabase Auth as the sign-in server for this site\'s /mcp', () => {
    expect(resourceMetadata('https://book.example.com', env)).toMatchObject({ resource: 'https://book.example.com/mcp', authorization_servers: ['https://project.supabase.co/auth/v1'] })
    expect(originOf({ headers: { host: 'localhost:3000' } })).toBe('http://localhost:3000')
    expect(originOf({ headers: { host: 'x' } }, { PUBLIC_SITE_URL: 'https://vadmassage.com/' })).toBe('https://vadmassage.com')
  })
})
