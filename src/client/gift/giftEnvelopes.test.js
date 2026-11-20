import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ART } from './giftArt.js'
import { ENVELOPES, envelopeFor } from './giftEnvelopes.js'

describe('the envelope a gift opens from', () => {
  it('is chosen for every voucher design, from a picture that is there', () => {
    for (const design of Object.keys(ART)) expect(Object.values(ENVELOPES), design).toContain(envelopeFor(design))
    for (const { src } of Object.values(ENVELOPES)) expect(existsSync(new URL(`../../../public${src}`, import.meta.url)), src).toBe(true)
  })

  it('matches the voucher: green and Christmas designs open from sage, pink ones from blush, the rest (and an unknown design) from ivory', () => {
    expect(envelopeFor('christmas_night').name).toBe('sage')
    expect(envelopeFor('birthday_pink').name).toBe('blush')
    expect(envelopeFor('navy_gold').name).toBe('ivory')
    expect(envelopeFor('something_new').name).toBe('ivory')
  })
})
