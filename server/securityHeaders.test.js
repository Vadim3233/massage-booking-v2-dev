import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The headers every page and function is served with (ADR-087). Checked here because Vercel applies them only when deployed.
const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
const headers = Object.fromEntries(config.headers.find(rule => rule.source === '/(.*)').headers.map(({ key, value }) => [key, value]))
const policy = Object.fromEntries(headers['Content-Security-Policy'].split(';').map(part => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]))

describe('security headers', () => {
  it('stops other sites from framing any page', () => {
    expect(policy['frame-ancestors']).toEqual(["'none'"])
    expect(headers['X-Frame-Options']).toBe('DENY')
  })
  it('runs only the site\'s own scripts, with nothing inline', () => {
    expect(policy['script-src']).toEqual(["'self'"])
    expect(headers['Content-Security-Policy']).not.toMatch(/unsafe-inline|unsafe-eval/)
    const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    expect(page).not.toMatch(/<script>(?!\s*<\/script>)/)
  })
  it('talks only to the site and its Supabase project', () => {
    expect(policy['connect-src']).toEqual(["'self'", 'https://jxmnfwoeqglnhruadbhp.supabase.co', 'wss://jxmnfwoeqglnhruadbhp.supabase.co'])
  })
  it('sends the other protective headers', () => {
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    expect(headers['Permissions-Policy']).toMatch(/camera=\(\)/)
  })
})
