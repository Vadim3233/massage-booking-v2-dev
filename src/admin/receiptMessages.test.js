import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SAFE_MESSAGES } from './receiptsApi.js'

// Every plain sentence the receipts database code raises for the Admin has to be on the list the screen is allowed to show,
// otherwise she would see "Could not complete that" instead of what is wrong. This reads the migration and compares.
// A later migration replaces some of the functions; the words of the latest version are the ones that count.
const read = name => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8')
const later = read('20261117100000_receipt_pdf.sql')
const replaced = [...later.matchAll(/create or replace function public\.(\w+)\(/g)].map(match => match[1])
const sql = replaced.reduce((text, name) => {
  const start = text.indexOf(`create function public.${name}(`)
  return start < 0 ? text : text.slice(0, start) + text.slice(text.indexOf('$$;', text.indexOf('$$', start) + 2) + 3)
}, read('20261023100000_booking_receipts.sql')) + later
const refusal = sql.slice(sql.indexOf('create function public.receipt_refusal'), sql.indexOf('$$;', sql.indexOf('create function public.receipt_refusal')))
const raised = [...sql.matchAll(/raise exception '([^'%]+)'/g)].map(match => match[1])
const refused = [...refusal.matchAll(/(?:then|else) '([^']+)'/g)].map(match => match[1])
// Messages deliberately never shown to the Admin as they are: someone who is not the Admin gets the generic line, and the last two
// are for a client asking for their own receipt (the client's screen has its own words for them).
const NOT_FOR_ADMIN = ['Admin authorization required', 'Authentication required', 'Booking is not available to this client']
const found = [...new Set([...raised, ...refused])].filter(message => !NOT_FOR_ADMIN.includes(message))

describe('the messages the receipts database code raises', () => {
  it('were found (so the checks below mean something)', () => {
    expect(found.length).toBeGreaterThan(20)
    expect(refused.length).toBeGreaterThanOrEqual(8)
  })
  it('can all be shown to the Admin as they are', () => {
    expect(found.filter(message => !SAFE_MESSAGES.has(message))).toEqual([])
  })
  it('are all that the screen\'s list holds (no stale or misspelt sentence)', () => {
    expect([...SAFE_MESSAGES].filter(message => !found.includes(message))).toEqual([])
  })
})
