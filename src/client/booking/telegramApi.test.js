import { describe, expect, it } from 'vitest'
import { createTelegramApi } from './telegramApi.js'

const clientWith = answers => {
  const calls = []
  return { calls, rpc: (name, args) => { calls.push([name, args]); const answer = answers[name]; return Promise.resolve(answer instanceof Error ? { data: null, error: answer } : { data: answer, error: null }) } }
}

describe("a client's Telegram updates, asked of the database", () => {
  it('asks whether a chat is linked, and says yes or no', async () => {
    const yes = clientWith({ my_telegram_status: { linked: true } })
    expect(await createTelegramApi(yes).status()).toBe(true)
    expect(yes.calls).toEqual([['my_telegram_status', undefined]])
    expect(await createTelegramApi(clientWith({ my_telegram_status: { linked: false } })).status()).toBe(false)
    for (const odd of [null, {}, { linked: 'yes please' }.nothing, { linked: 0 }]) expect(await createTelegramApi(clientWith({ my_telegram_status: odd })).status()).toBe(false)
  })
  it('asks for a one-time code, and gives back what the database made', async () => {
    const client = clientWith({ create_my_telegram_link: 'abcdef0123456789abcdef0123456789' })
    expect(await createTelegramApi(client).createLink()).toBe('abcdef0123456789abcdef0123456789')
    expect(client.calls).toEqual([['create_my_telegram_link', undefined]])
  })
  it('lets a refusal through, for the box to hide itself', async () => {
    const refused = Object.assign(new Error('Please wait a little before asking again.'), { code: 'PT429' })
    await expect(createTelegramApi(clientWith({ create_my_telegram_link: refused })).createLink()).rejects.toBe(refused)
    await expect(createTelegramApi(clientWith({ my_telegram_status: refused })).status()).rejects.toBe(refused)
  })
})
