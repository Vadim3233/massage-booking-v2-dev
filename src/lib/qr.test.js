import { describe, expect, it } from 'vitest'
import { qrMatrix } from './qr.js'

// Checked against a reference QR library while it was written (every mask, versions 1 to 10); these keep the shape right.
describe('qrMatrix', () => {
  const finder = (m, row, col) => [0, 1, 2, 3, 4, 5, 6].every(r => [0, 1, 2, 3, 4, 5, 6].every(c => m[row + r][col + c] === (Math.max(Math.abs(r - 3), Math.abs(c - 3)) !== 2)))
  it('makes the smallest symbol that fits', () => {
    expect(qrMatrix('hi').length).toBe(21)
    expect(qrMatrix('https://book.vadmassage.com/?gift=7K3M-QX9P').length).toBe(33)
  })
  it('has the three finder patterns, the timing line and the dark module', () => {
    const m = qrMatrix('https://book.vadmassage.com/?gift=7K3M-QX9P')
    const n = m.length
    expect(finder(m, 0, 0) && finder(m, 0, n - 7) && finder(m, n - 7, 0)).toBe(true)
    for (let i = 8; i < n - 8; i += 1) { expect(m[6][i]).toBe(i % 2 === 0); expect(m[i][6]).toBe(i % 2 === 0) }
    expect(m[n - 8][8]).toBe(true)
  })
  it('gives the same picture for the same text, and refuses text that is far too long', () => {
    expect(qrMatrix('abc')).toEqual(qrMatrix('abc'))
    expect(() => qrMatrix('x'.repeat(400))).toThrow()
  })
})
