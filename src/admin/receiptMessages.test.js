import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SAFE_MESSAGES } from './receiptsApi.js'

// Every plain sentence the receipts database code raises for the Admin has to be on the list the screen is allowed to show,
// otherwise she would see "Could not complete that" instead of what is wrong. This reads the migration and compares.
const sql = readFileSync(new URL('../../supabase/migrations/20261023100000_booking_receipts.sql', import.meta.url), 'utf8')
const refusal = sql.slice(sql.indexOf('create function public.receipt_refusal'), sql.indexOf('$$;', sql.indexOf('create function public.receipt_refusal')))
const raised = [...sql.matchAll(/raise exception '([^'%]+)'/g)].map(match => match[1])
const refused = [...refusal.matchAll(/(?:then|else) '([^']+)'/g)].map(match => match[1])
// The one message that is deliberately never shown as it is: someone who is not the Admin gets the generic line.
const found = [...new Set([...raised, ...refused])].filter(message => message !== 'Admin authorization required')

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
