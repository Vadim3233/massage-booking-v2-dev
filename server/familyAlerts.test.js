import { describe, expect, it } from 'vitest'
import { createFamilySender } from './familyAlerts.js'

const TOKEN = '777:CLIENT-BOT-TOKEN'
const message = (overrides = {}) => ({ id: 'f1', chat_id: 424242, body: '📅 Nueva reserva\n🕑 jue 14 nov, de 14:00 a 15:30', ...overrides })

function fakeClient(rows, { claimError = null } = {}) {
  const completed = []
  const stopped = []
  return { completed, stopped, async rpc(name, args) {
    if (name === 'claim_family_telegram_messages') return claimError ? { data: null, error: claimError } : { data: rows, error: null }
    if (name === 'complete_family_telegram_message') { completed.push(args); return { error: null } }
    if (name === 'stop_family_telegram') { stopped.push(args); return { data: 1, error: null } }
    throw new Error(`unexpected ${name}`)
  } }
}
const answer = (body, ok = true, status = 200) => ({ ok, status, json: async () => body })

describe('the family alerts sender', () => {
  it('sends each message to its chat with the clients bot, and records it sent', async () => {
    const client = fakeClient([message()])
    const calls = []
    const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return answer({ ok: true }) }
    const result = await createFamilySender({ client, token: TOKEN, fetchImpl }).run()
    expect(result).toEqual({ claimed: 1, sent: 1, failed: 0 })
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`)
    expect(calls[0].body).toEqual({ chat_id: 424242, text: message().body, disable_web_page_preview: true })
    expect(client.completed).toEqual([{ p_id: 'f1', p_ok: true, p_error: null }])
  })
  it('records a failure without the token in it, and switches off a chat that blocked the bot', async () => {
    const client = fakeClient([message()])
    const fetchImpl = async () => answer({ ok: false, error_code: 403, description: `Forbidden: bot was blocked by the user ${TOKEN}` }, false, 403)
    const result = await createFamilySender({ client, token: TOKEN, fetchImpl }).run()
    expect(result).toEqual({ claimed: 1, sent: 0, failed: 1 })
    expect(client.stopped).toEqual([{ p_chat_id: 424242 }])
    expect(client.completed[0].p_ok).toBe(false)
    expect(client.completed[0].p_error).not.toContain(TOKEN)
  })
  it('does nothing without the bot, and quietly waits when the database update is not applied yet', async () => {
    expect(await createFamilySender({ client: fakeClient([message()]), token: '' }).run()).toEqual({ claimed: 0, sent: 0, failed: 0 })
    const missing = fakeClient([], { claimError: { code: 'PGRST202', message: 'not found' } })
    expect(await createFamilySender({ client: missing, token: TOKEN, fetchImpl: async () => { throw new Error('no call expected') } }).run())
      .toEqual({ claimed: 0, sent: 0, failed: 0, unavailable: true })
  })
})
