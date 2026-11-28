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
    expect((await answer({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, fakeTools)).result.protocolVersion).toBe('2025-11-25')
    expect((await answer({ jsonrpc: '2.0', id: 1, method: 'prompts/list' }, fakeTools)).error.code).toBe(-32601)
    expect((await answer({ id: 1 }, fakeTools)).error.code).toBe(-32600)
  })
  it('gives a tool result as text and as structured content', async () => {
    expect((await answer({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'good', arguments: {} } }, fakeTools)).result)
      .toEqual({ content: [{ type: 'text', text: '{\n  "ok": true\n}' }], structuredContent: { ok: true }, isError: false })
  })
})

const modernMeta = (capabilities = {}) => ({ 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': capabilities })

describe('the 2026-07-28 protocol (no initialize, version in every request)', () => {
  it('describes itself on server/discover, with the booking guide as a skill', async () => {
    const result = (await answer({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: modernMeta() } }, fakeTools)).result
    expect(result).toMatchObject({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {}, extensions: { 'io.modelcontextprotocol/skills': {} } } })
    expect(result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('vad-massage-booking')
    expect(result.instructions).toMatch(/get_my_booking_options/)
  })
  it('lists and gives the skill, and reads its file', async () => {
    const list = (await answer({ jsonrpc: '2.0', id: 2, method: 'skills/list', params: { _meta: modernMeta() } }, fakeTools)).result
    expect(list.skills).toHaveLength(1)
    expect(list.skills[0]).toMatchObject({ uri: 'skill://book-with-vadim/SKILL.md', frontmatter: { name: 'book-with-vadim' } })
    expect(list.skills[0].resources[0].digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(list).toMatchObject({ ttlMs: 300000, cacheScope: 'public' })
    const got = (await answer({ jsonrpc: '2.0', id: 3, method: 'skills/get', params: { uri: 'skill://book-with-vadim/SKILL.md', _meta: modernMeta() } }, fakeTools)).result
    expect(got.skill.uri).toBe('skill://book-with-vadim/SKILL.md')
    expect((await answer({ jsonrpc: '2.0', id: 4, method: 'skills/get', params: { uri: 'skill://other/SKILL.md', _meta: modernMeta() } }, fakeTools)).error.code).toBe(-32602)
    const file = (await answer({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'skill://book-with-vadim/SKILL.md', _meta: modernMeta() } }, fakeTools)).result
    expect(file.contents[0].text).toMatch(/^---\nname: book-with-vadim\n/)
  })
  it('refuses another modern version, naming the ones it speaks, and a request without capabilities', async () => {
    const wrong = await answer({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2027-01-01', 'io.modelcontextprotocol/clientCapabilities': {} } } }, fakeTools)
    expect(wrong).toMatchObject({ status: 400, error: { code: -32022, data: { supported: ['2026-07-28'] } } })
    const none = await answer({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }, fakeTools)
    expect(none).toMatchObject({ status: 400, error: { code: -32602 } })
  })
  it('passes whether the app can show a card, and the card\'s answer, to the tool, and returns a card as input required', async () => {
    const call = vi.fn(async () => ({ isError: false, inputRequired: { inputRequests: { confirm: { method: 'elicitation/create' } }, requestState: 's' } }))
    const tools = { list: () => [], call }
    const result = (await answer({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'cancel_booking', arguments: { booking_reference: 'VAD-1' }, inputResponses: { confirm: { action: 'accept' } }, requestState: 'r', _meta: modernMeta({ elicitation: { form: {} } }) } }, tools)).result
    expect(result).toMatchObject({ resultType: 'input_required', inputRequests: { confirm: { method: 'elicitation/create' } }, requestState: 's' })
    expect(call).toHaveBeenCalledWith('cancel_booking', { booking_reference: 'VAD-1' }, { card: true, inputResponses: { confirm: { action: 'accept' } }, requestState: 'r' })
    await answer({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'cancel_booking', arguments: {}, _meta: modernMeta({}) } }, tools)
    expect(call.mock.calls[1][2].card).toBe(false)
  })
  it('does not fall over on a request with params: null', async () => {
    expect((await answer({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: null }, fakeTools)).error.code).toBe(-32602)
  })
  it('marks ordinary results complete, and answers an unknown method with 404', async () => {
    expect((await answer({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'good', arguments: {}, _meta: modernMeta() } }, fakeTools)).result)
      .toMatchObject({ resultType: 'complete', structuredContent: { ok: true }, isError: false })
    expect(await answer({ jsonrpc: '2.0', id: 9, method: 'nope', params: { _meta: modernMeta() } }, fakeTools)).toMatchObject({ status: 404, error: { code: -32601 } })
  })
  it('sends the HTTP status with the error over the wire', async () => {
    const result = await exchange({ headers: { host: 'book.example.com', authorization: 'Bearer token' }, body: { jsonrpc: '2.0', id: 1, method: 'nope', params: { _meta: modernMeta() } } }, { env, makeClient: signedIn(), makeTools: () => fakeTools })
    expect(result.statusCode).toBe(404)
    expect(result.json).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found: nope' } })
  })
})

describe('the booking guide for older assistants', () => {
  it('is a plain resource too', async () => {
    expect((await answer({ jsonrpc: '2.0', id: 1, method: 'resources/list' }, fakeTools)).result.resources[0].uri).toBe('skill://book-with-vadim/SKILL.md')
    expect((await answer({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'skill://book-with-vadim/SKILL.md' } }, fakeTools)).result.contents[0].mimeType).toBe('text/markdown')
  })
})

describe('where to sign in', () => {
  it('names Supabase Auth as the sign-in server for this site\'s /mcp', () => {
    expect(resourceMetadata('https://book.example.com', env)).toMatchObject({ resource: 'https://book.example.com/mcp', authorization_servers: ['https://project.supabase.co/auth/v1'] })
    expect(originOf({ headers: { host: 'localhost:3000' } })).toBe('http://localhost:3000')
    expect(originOf({ headers: { host: 'x' } }, { PUBLIC_SITE_URL: 'https://vadmassage.com/' })).toBe('https://vadmassage.com')
  })
})
