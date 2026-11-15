import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Two side-by-side parts of one page must never share a React key. When they do (for example three parts all keyed by the client's id), React
// loses track of them each time something above them appears or disappears, and leaves old copies on the screen. That is how the client page
// came to show "Telegram updates" over and over. This test looks at every component file for parts placed on the page (not in a list made with
// .map, and not one-of-several returns) that use the very same key, and fails if it finds any.
const src = fileURLToPath(new URL('..', import.meta.url))
const files = dir => readdirSync(dir).flatMap(name => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? files(path) : path.endsWith('.jsx') ? [path] : []
})

export function sharedSiblingKeys(source) {
  const seen = new Map()
  for (const line of source.split('\n')) {
    if (line.includes('.map(') || /=>\s*</.test(line) || /\breturn\s*</.test(line)) continue
    for (const [, key] of line.matchAll(/<[A-Za-z][\w.]*\s+key=\{([^}]+)\}/g)) seen.set(key, (seen.get(key) || 0) + 1)
  }
  return [...seen].filter(([, count]) => count > 1).map(([key]) => key)
}

describe('React keys of parts side by side', () => {
  it('finds a key shared by two parts', () => {
    expect(sharedSiblingKeys('    <Telegram key={client.id} />\n    <CashTrust key={client.id} />')).toEqual(['client.id'])
    expect(sharedSiblingKeys('    <Telegram key={`telegram-${client.id}`} />\n    <CashTrust key={`cash-${client.id}`} />')).toEqual([])
  })

  it('no component file gives two parts the same key', () => {
    const problems = files(src).flatMap(path => sharedSiblingKeys(readFileSync(path, 'utf8')).map(key => `${relative(src, path)}: key={${key}}`))
    expect(problems).toEqual([])
  })

  it('the client page gives Telegram, payment reminder and cash parts their own keys', () => {
    const page = readFileSync(join(src, 'admin', 'ClientProfile.jsx'), 'utf8')
    expect(page).toContain('<ClientTelegram key={`telegram-${client.id}`}')
    expect(page).toContain('<ClientPaymentReminder key={`reminder-${client.id}`}')
    expect(page).toContain('<CashTrust key={`cash-${client.id}`}')
  })
})
