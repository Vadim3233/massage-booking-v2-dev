// A small QR code maker for the gift vouchers' "Scan to book" code (no library: the repository adds none without Vadim's say).
// Byte mode, error correction level M, versions 1 to 10 (up to 213 bytes, far more than a link needs). Follows ISO/IEC 18004.
// qrMatrix(text) gives rows of booleans (true = dark), without the quiet zone.

// Per version (index 1 to 10), level M: error-correction codewords per block, then [blocks, data codewords per block] for each group.
const BLOCKS = [null,
  [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]],
  [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]]]
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]
const REMAINDER = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0]

// Arithmetic in GF(256) with the QR polynomial 0x11d.
const EXP = new Array(512)
const LOG = new Array(256)
for (let i = 0, x = 1; i < 255; i += 1) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d }
for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0)

function generator(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0)
    poly.forEach((coef, j) => { next[j] ^= coef; next[j + 1] ^= mul(coef, EXP[i]) })
    poly = next
  }
  return poly
}
function remainder(data, degree) {
  const gen = generator(degree)
  const out = [...data, ...new Array(degree).fill(0)]
  for (let i = 0; i < data.length; i += 1) {
    const factor = out[i]
    if (factor) gen.forEach((coef, j) => { out[i + j] ^= mul(coef, factor) })
  }
  return out.slice(data.length)
}

const dataCapacity = version => BLOCKS[version].slice(1).reduce((sum, [count, size]) => sum + count * size, 0)

function codewords(bytes, version) {
  const capacity = dataCapacity(version)
  const bits = []
  const put = (value, length) => { for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1) }
  put(0b0100, 4)
  put(bytes.length, version < 10 ? 8 : 16)
  bytes.forEach(byte => put(byte, 8))
  put(0, Math.min(4, capacity * 8 - bits.length))
  while (bits.length % 8) bits.push(0)
  const data = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0))
  for (let pad = 0; data.length < capacity; pad += 1) data.push(pad % 2 ? 0x11 : 0xec)
  // Split into blocks, add error correction to each, then interleave.
  const [ecSize, ...groups] = BLOCKS[version]
  const blocks = []
  let at = 0
  groups.forEach(([count, size]) => { for (let i = 0; i < count; i += 1) { const block = data.slice(at, at + size); at += size; blocks.push({ data: block, ec: remainder(block, ecSize) }) } })
  const out = []
  const longest = Math.max(...blocks.map(block => block.data.length))
  for (let i = 0; i < longest; i += 1) blocks.forEach(block => { if (i < block.data.length) out.push(block.data[i]) })
  for (let i = 0; i < ecSize; i += 1) blocks.forEach(block => out.push(block.ec[i]))
  return out
}

function bch(value, poly, shift) {
  let rest = value << shift
  const top = 31 - Math.clz32(poly)
  while (31 - Math.clz32(rest) >= top) rest ^= poly << ((31 - Math.clz32(rest)) - top)
  return (value << shift) | rest
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0]

function build(version, words, mask) {
  const size = version * 4 + 17
  const dark = Array.from({ length: size }, () => new Array(size).fill(false))
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (r, c, value) => { if (r >= 0 && c >= 0 && r < size && c < size) { dark[r][c] = value; fixed[r][c] = true } }
  // Finder patterns with their separators.
  for (const [row, col] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r += 1) for (let c = -1; c <= 7; c += 1) {
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3))
      set(row + r, col + c, ring !== 2 && ring !== 4)
    }
  }
  // Alignment patterns.
  const spots = ALIGN[version]
  for (const r of spots) for (const c of spots) {
    if (fixed[r][c]) continue
    for (let dr = -2; dr <= 2; dr += 1) for (let dc = -2; dc <= 2; dc += 1) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1)
  }
  // Timing patterns.
  for (let i = 8; i < size - 8; i += 1) { if (!fixed[6][i]) set(6, i, i % 2 === 0); if (!fixed[i][6]) set(i, 6, i % 2 === 0) }
  // Format information (level M is 00), and the dark module.
  const format = bch(mask, 0x537, 10) ^ 0x5412
  for (let i = 0; i < 15; i += 1) {
    const bit = ((format >>> i) & 1) === 1
    // Beside the top-left finder…
    if (i < 6) set(i, 8, bit); else if (i === 6) set(7, 8, bit); else if (i === 7) set(8, 8, bit); else if (i === 8) set(8, 7, bit); else set(8, 14 - i, bit)
    // …and again beside the other two.
    if (i < 8) set(8, size - 1 - i, bit); else set(size - 15 + i, 8, bit)
  }
  set(size - 8, 8, true)
  // Version information (versions 7 and up).
  if (version >= 7) {
    const info = bch(version, 0x1f25, 12)
    for (let i = 0; i < 18; i += 1) {
      const bit = ((info >>> i) & 1) === 1
      set(Math.floor(i / 3), size - 11 + (i % 3), bit)
      set(size - 11 + (i % 3), Math.floor(i / 3), bit)
    }
  }
  // The data, in the zigzag order, masked.
  const bits = []
  words.forEach(word => { for (let i = 7; i >= 0; i -= 1) bits.push((word >>> i) & 1) })
  for (let i = 0; i < REMAINDER[version]; i += 1) bits.push(0)
  let index = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let step = 0; step < size; step += 1) {
      const upward = ((right + 1) & 2) === 0
      const r = upward ? size - 1 - step : step
      for (let j = 0; j < 2; j += 1) {
        const c = right - j
        if (fixed[r][c]) continue
        const bit = index < bits.length ? bits[index] === 1 : false
        index += 1
        dark[r][c] = bit !== MASKS[mask](r, c)
      }
    }
  }
  return dark
}

// The usual penalty score: runs, 2 × 2 blocks, finder-like patterns and an unbalanced mix of dark and light.
function penalty(dark) {
  const size = dark.length
  let score = 0
  const lines = [...dark, ...dark[0].map((_, c) => dark.map(row => row[c]))]
  for (const line of lines) {
    let run = 1
    for (let i = 1; i <= size; i += 1) {
      if (i < size && line[i] === line[i - 1]) run += 1
      else { if (run >= 5) score += run - 2; run = 1 }
    }
    for (let i = 0; i + 10 < size + 1; i += 1) {
      const window = line.slice(i, i + 11).map(Number).join('')
      if (window === '10111010000' || window === '00001011101') score += 40
    }
  }
  for (let r = 0; r < size - 1; r += 1) for (let c = 0; c < size - 1; c += 1) {
    const v = dark[r][c]
    if (v === dark[r][c + 1] && v === dark[r + 1][c] && v === dark[r + 1][c + 1]) score += 3
  }
  const darkCount = dark.reduce((sum, row) => sum + row.filter(Boolean).length, 0)
  score += Math.floor(Math.abs(darkCount * 20 - size * size * 10) / (size * size)) * 10
  return score
}

export function qrMatrix(text, forcedMask = null) {
  const bytes = [...new TextEncoder().encode(String(text))]
  let version = 1
  while (version <= 10 && dataCapacity(version) < bytes.length + (version < 10 ? 2 : 3)) version += 1
  if (version > 10) throw new Error('That link is too long for the QR code.')
  const words = codewords(bytes, version)
  let best = null
  for (const mask of forcedMask == null ? [0, 1, 2, 3, 4, 5, 6, 7] : [forcedMask]) {
    const dark = build(version, words, mask)
    const score = penalty(dark)
    if (!best || score < best.score) best = { dark, score }
  }
  return best.dark
}
