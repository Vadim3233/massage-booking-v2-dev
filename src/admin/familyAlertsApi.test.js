import { describe, expect, it } from 'vitest'
import { createFamilyAlertsApi, familyInviteMessage, familyInviteWhatsappLink } from './familyAlertsApi.js'

const client = answers => ({ calls: [], async rpc(name, args) { this.calls.push([name, args]); return answers[name] } })

describe('family alerts, from the admin page', () => {
  it('reads the linked chats, makes a link and switches one off', async () => {
    const fake = client({
      admin_family_telegram_status: { data: { chats: [{ id: 'c1', linked_at: '2026-11-11T12:00:00Z' }] }, error: null },
      admin_create_family_telegram_link: { data: 'family_0123456789abcdef0123456789abcdef', error: null },
      admin_stop_family_telegram: { data: null, error: null },
    })
    const api = createFamilyAlertsApi(fake)
    expect(await api.status()).toEqual([{ id: 'c1', linked_at: '2026-11-11T12:00:00Z' }])
    expect(await api.createLink()).toBe('family_0123456789abcdef0123456789abcdef')
    await api.stop('c1')
    expect(fake.calls.at(-1)).toEqual(['admin_stop_family_telegram', { p_id: 'c1' }])
  })
  it('says plainly when the database update is still to apply, and passes on only the safe message', async () => {
    const api = createFamilyAlertsApi(client({
      admin_family_telegram_status: { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.admin_family_telegram_status' } },
      admin_create_family_telegram_link: { data: null, error: { message: 'Please wait a little before asking again.' } },
    }))
    await expect(api.status()).rejects.toThrow('Family alerts need a database update first.')
    await expect(api.createLink()).rejects.toThrow('Please wait a little before asking again.')
  })
  it('writes the invitation in Spanish with the link, ready for WhatsApp', () => {
    const text = familyInviteMessage('https://t.me/VadBot?start=family_x')
    expect(text).toContain('https://t.me/VadBot?start=family_x')
    expect(text).toMatch(/^¡Hola mi amor!/)
    expect(familyInviteWhatsappLink(text)).toBe(`https://wa.me/?text=${encodeURIComponent(text)}`)
  })
})
