// Gift vouchers (Vadim, 14 Nov 2026; ADR-101). The database keeps the prices, the codes and what a voucher pays
// (20261214100000_gift_vouchers.sql); this file is only the words and choices the gift pages show.

// The five designs, as the database names them. The Christmas ones come first in November and December, "Any occasion" first the rest of the year.
export const DESIGNS = [
  { id: 'christmas_night', name: 'Christmas night', christmas: true },
  { id: 'wrapped_present', name: 'Wrapped present', christmas: true },
  { id: 'gold_foil', name: 'Gold foil', christmas: true },
  { id: 'black_gold', name: 'Black and gold', christmas: false },
  { id: 'any_occasion', name: 'Any occasion', christmas: false },
]
export const isChristmasTime = (date = new Date()) => date.getMonth() >= 10
export function designsInOrder(date = new Date()) {
  if (isChristmasTime(date)) return DESIGNS
  return [...DESIGNS.filter(design => design.id === 'any_occasion'), ...DESIGNS.filter(design => design.id !== 'any_occasion')]
}
export const designName = id => DESIGNS.find(design => design.id === id)?.name || DESIGNS[0].name

// Ready messages, so nobody has to think of one. "Love, <from> x" is added to whichever is picked, and every one can be changed.
export const OCCASIONS = [
  { name: 'Christmas', christmas: true, messages: [
    'Happy Christmas! This year, it’s your turn to be looked after.',
    'Merry Christmas! An hour of pure calm, at home, whenever you like.',
    'Wishing you a cosy Christmas and a very relaxing New Year.',
    'No wrapping paper needed. Just lie back and enjoy. Happy Christmas!'] },
  { name: 'For Mum', messages: [
    'For the best mum in the world. You deserve every minute of this.',
    'Thank you for always looking after everyone. Now it’s your turn.',
    'Put your feet up, Mum. This one is all for you.'] },
  { name: 'For Dad', messages: [
    'For the best dad. Time to switch off and relax.',
    'All those years of hard work. Your shoulders will thank me!'] },
  { name: 'Partner', messages: [
    'For the one I love. Time to unwind, just for you.',
    'You make every day better. Now let someone make yours.',
    'A little time for you, because you mean the world to me.'] },
  { name: 'Birthday', messages: [
    'Happy birthday! Enjoy some time that’s just for you.',
    'Another year wiser. Celebrate with a proper treat!',
    'Happy birthday! Relax, unwind, and enjoy your day.'] },
  { name: 'Thank you', messages: [
    'Thank you for everything. I hope this helps you relax.',
    'A small thank you for all you do.'] },
  { name: 'Get well', messages: [
    'Sending you love. I hope this helps you feel more like yourself.',
    'Rest, recover and be kind to your body. Thinking of you.'] },
  { name: 'Just because', messages: [
    'Just because you deserve it.',
    'You’ve been working so hard. Time for a proper break.',
    'Life is busy. Here is an hour of calm, just for you.'] },
]
export function occasionsInOrder(date = new Date()) {
  return isChristmasTime(date) ? OCCASIONS : [...OCCASIONS.filter(item => !item.christmas), ...OCCASIONS.filter(item => item.christmas)]
}
export const withLove = (message, from) => `${message.trim()} Love, ${from.trim() || '…'} x`
export const MESSAGE_LIMIT = 400

// The line above the name on the voucher: Christmas words only on a Christmas design with a Christmas message.
export function kicker(design, message = '') {
  const christmasDesign = DESIGNS.find(item => item.id === design)?.christmas
  const christmasWords = /christmas|xmas|new year/i.test(message)
  if (design === 'gold_foil' || design === 'black_gold') return 'A special gift for'
  if (design === 'wrapped_present') return 'To'
  return christmasDesign && christmasWords ? 'A Christmas gift for' : 'A little gift of calm for'
}

// "A 60-minute massage", "A 2-hour massage for two".
export function giftWords(minutes, people = 1) {
  const length = minutes >= 120 && minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`
  return `A ${length} massage${people === 2 ? ' for two' : ''}`
}

// What can be bought: each length for one, and the shortest for two ("Massage for two, 60 min each").
export function giftChoices(lengths) {
  const list = lengths.map(({ minutes, price }) => ({ key: `${minutes}x1`, minutes, people: 1, price: Number(price),
    title: `${giftWords(minutes).slice(2)}`, note: 'One person' }))
  const shortest = lengths[0]
  if (shortest) list.push({ key: `${shortest.minutes}x2`, minutes: shortest.minutes, people: 2, price: Number(shortest.price) * 2, title: 'Massage for two', note: `${shortest.minutes} min each` })
  // The middle length is the one most people give.
  const loved = lengths.find(item => item.minutes === 90)
  return list.map(item => ({ ...item, loved: Boolean(loved) && item.people === 1 && item.minutes === 90 }))
}

// What the travel part adds: a known area adds its own charges, "Not sure yet" adds the most any area adds (everything included) or nothing.
export function travelPart(options, choice) {
  if (choice.area === 'unsure') return choice.cover === 'all' ? Number(options.all_areas_cover) : 0
  const area = options.areas.find(item => item.id === choice.area)
  return area ? Number(area.travel) + Number(area.congestion) : 0
}
export const travelChoice = choice => (choice.area === 'unsure' ? (choice.cover === 'all' ? 'all' : 'none') : 'area')

// The code in a voucher's link (/gift/7K3M-QX9P), as the database keeps it, or null.
export function codeFromPath(path) {
  const match = /^\/gift\/([A-Za-z0-9-]{8,12})\/?$/.exec(path || '')
  if (!match) return null
  const code = match[1].replace(/-/g, '').toUpperCase()
  return /^[A-Z0-9]{8}$/.test(code) ? code : null
}
export const codeShown = code => (code && code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code || '')
export const giftLink = (origin, code) => `${origin}/gift/${codeShown(code)}`
export const bookingLink = (origin, code) => `${origin}/?gift=${codeShown(code)}`

// The WhatsApp message that carries the voucher.
export function whatsappText(voucher, origin) {
  return `${voucher.from_name} has sent you a gift: ${giftWords(voucher.minutes, voucher.people).toLowerCase()} at your home 🎁\n\nOpen it here: ${giftLink(origin, voucher.code)}`
}
export const whatsappHref = text => `https://wa.me/?text=${encodeURIComponent(text)}`

export const londonDate = iso => (iso ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }).format(new Date(iso)) : '')
export const whole = amount => `£${Number(amount).toFixed(2).replace(/\.00$/, '')}`
