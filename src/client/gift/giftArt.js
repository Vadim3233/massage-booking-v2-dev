// The six voucher designs are Vadim's own pictures (19 Nov 2026), each cleaned of its sample words and saved in public/gift-voucher-*.webp.
// Everything that changes from voucher to voucher (name, what it is for, message, from, valid until, QR code, code) is laid on top, where his
// picture had it. Positions are in the picture's own pixels and turned into percentages, so the voucher looks the same at any size.
// x is the centre of a centred line (or the left edge when align is 'left'); y is the top of the text block (cy: its middle).

const PLAYFAIR = "'Playfair Display', Georgia, serif"
const SCRIPT = "'Great Vibes', 'Playfair Display', cursive"

export const ART = {
  navy_gold: {
    src: '/gift-voucher-navy.webp', w: 1366, h: 864, ink: '#fbf3e4',
    name: { x: 681, cy: 290, size: 134, maxW: 570, font: PLAYFAIR, gold: true },
    what: { x: 266, y: 377, w: 760, size: 40, align: 'left' },
    msg: { x: 266, y: 470, w: 760, size: 33, maxH: 190, align: 'left' },
    small: { x: 686, y: 683, w: 820, size: 23 },
    qr: { x: 1066, y: 220, s: 230, pad: 20, bg: '#fbf3e4' },
    scan: { x: 1181, cy: 480, size: 25 },
    code: { x: 1181, cy: 533, size: 35, color: '#e6c47a' },
  },
  christmas_night: {
    src: '/gift-voucher-green.webp', w: 1376, h: 864, ink: '#fbf3e4',
    name: { x: 692, cy: 289, size: 186, maxW: 470, font: PLAYFAIR, gold: true },
    what: { x: 614, y: 401, w: 780, size: 44 },
    msg: { x: 624, y: 485, w: 760, size: 36, maxH: 165 },
    small: { x: 691, y: 671, w: 800, size: 23 },
    qr: { x: 1089, y: 240, s: 195 },
    code: { x: 1186, cy: 540, size: 37, color: '#f0cf6a' },
  },
  wrapped_present: {
    src: '/gift-voucher-red.webp', w: 1375, h: 870, ink: '#fbf3e4',
    name: { x: 664, cy: 298, size: 180, maxW: 470, font: PLAYFAIR, gold: true },
    what: { x: 609, y: 404, w: 770, size: 42 },
    msg: { x: 624, y: 485, w: 760, size: 36, maxH: 142 },
    small: { x: 686, y: 674, w: 800, size: 23 },
    qr: { x: 1084, y: 242, s: 196 },
    code: { x: 1182, cy: 542, size: 35, color: '#f0cf6a' },
  },
  gold_foil: {
    src: '/gift-voucher-ticket.webp', w: 1563, h: 902, ink: '#1f2f26',
    name: { x: 711, cy: 345, size: 180, maxW: 540, font: SCRIPT, gold: true, script: true },
    what: { x: 661, y: 452, w: 600, size: 55, weight: 500, short: true },
    msg: { x: 674, y: 603, w: 780, size: 40, maxH: 172 },
    small: { x: 656, y: 785, w: 900, size: 22, oneLine: true },
    qr: { x: 1221, y: 260, s: 236 },
    code: { x: 1343, cy: 662, size: 41, color: '#1f3a2c', spacing: '.1em' },
  },
  black_gold: {
    src: '/gift-voucher-black.webp', w: 1475, h: 876, ink: '#f6efe0',
    name: { x: 722, cy: 345, size: 175, maxW: 520, font: SCRIPT, gold: true, script: true },
    what: { x: 682, y: 457, w: 780, size: 44, weight: 600 },
    msg: { x: 684, y: 537, w: 760, size: 36, maxH: 150 },
    small: { x: 760, y: 715, w: 800, size: 23 },
    qr: { x: 1182, y: 243, s: 202 },
    code: { x: 1284, cy: 558, size: 37, color: '#e6c47a' },
  },
  any_occasion: {
    src: '/gift-voucher-pink.webp', w: 1473, h: 888, ink: '#1d2f4a',
    name: { x: 708, cy: 301, size: 165, maxW: 640, font: PLAYFAIR, prefix: 'for ' },
    what: { x: 692, y: 418, w: 780, size: 40, weight: 500 },
    msg: { x: 703, y: 506, w: 760, size: 36, maxH: 168 },
    small: { x: 776, y: 712, w: 760, size: 22 },
    qr: { x: 1190, y: 291, s: 188 },
    code: { x: 1288, cy: 584, size: 37, color: '#a5562a' },
  },
  // Occasion designs: the big words are part of the picture, so the person's name goes on a line just under them ("For Sarah, from Tom").
  birthday_navy: {
    src: '/gift-voucher-bday1.webp', w: 1536, h: 1024, ink: '#16294a', occasion: true,
    words: { x: 770, y: 556, w: 780, maxH: 250 }, nameLine: { size: 34, color: '#a8782a' },
    what: { size: 44, weight: 500 }, msg: { size: 36 },
    small: { x: 872, y: 864, w: 820, size: 24 },
    qr: { x: 1250, y: 302, s: 205 },
    code: { x: 1355, cy: 677, size: 40, color: '#0f2340', spacing: '.08em' },
  },
  birthday_pink: {
    src: '/gift-voucher-bday2.webp', w: 1536, h: 1024, ink: '#1b2a48', occasion: true,
    words: { x: 752, y: 490, w: 760, maxH: 262 }, nameLine: { size: 34, color: '#a8782a' },
    what: { size: 44, weight: 500 }, msg: { size: 36 },
    small: { x: 780, y: 806, w: 820, size: 24 },
    qr: { x: 1228, y: 362, s: 202 },
    code: { x: 1333, cy: 659, size: 40, color: '#9a6a1c', spacing: '.04em' },
  },
  for_him: {
    src: '/gift-voucher-him.webp', w: 1536, h: 1024, ink: '#f3ead6', occasion: true,
    words: { x: 785, y: 490, w: 740, maxH: 226 }, nameLine: { size: 34, color: '#e2b863' },
    what: { size: 44, weight: 400 }, msg: { size: 36 },
    small: { x: 968, y: 770, w: 820, size: 24 },
    qr: { x: 1232, y: 266, s: 206 },
    code: { x: 1340, cy: 636, size: 40, color: '#e2b863', spacing: '.08em' },
  },
  anniversary: {
    src: '/gift-voucher-anniv.webp', w: 1536, h: 1024, ink: '#141820', occasion: true,
    words: { x: 800, y: 636, w: 640, maxH: 180 }, nameLine: { size: 30, color: '#9a6a1c' },
    what: { size: 38, weight: 400 }, msg: { size: 28 },
    small: { x: 870, y: 852, w: 760, size: 24 },
    qr: { x: 1226, y: 378, s: 196 },
    code: { x: 1333, cy: 712, size: 40, color: '#151515', spacing: '.08em' },
  },
  new_baby: {
    src: '/gift-voucher-baby.webp', w: 1536, h: 1024, ink: '#152a4a', occasion: true,
    words: { x: 785, y: 552, w: 720, maxH: 214 }, nameLine: { size: 33, color: '#9a6a1c' },
    what: { size: 42, weight: 400 }, msg: { size: 34 },
    small: { x: 985, y: 814, w: 760, size: 24 },
    qr: { x: 1246, y: 333, s: 196 },
    code: { x: 1350, cy: 682, size: 40, color: '#152a4a', spacing: '.08em' },
  },
}

// A long name gets smaller so it stays inside its space. Script and serif italics are roughly half as wide as they are tall.
export function nameSize(name, { size, maxW, script }) {
  const width = Math.max(String(name || '').length, 1) * (script ? 0.42 : 0.5)
  return Math.min(size, maxW / width)
}

// A long message gets smaller so it fits above the line.
export function messageScale(text) {
  const n = String(text || '').length
  return n > 260 ? 0.55 : n > 180 ? 0.66 : n > 100 ? 0.78 : n > 60 ? 0.9 : 1
}
