// Gift vouchers (Vadim, 14 Nov 2026; ADR-101). The database keeps the prices, the codes and what a voucher pays
// (20261214100000_gift_vouchers.sql); this file is only the words and choices the gift pages show.

// The eleven designs, as the database names them; each is one of Vadim's own pictures (giftArt.js, 19 Nov 2026). "Navy and gold" (the booking
// page's "Give the Gift of Wellness" card) always comes first, then the Christmas ones in November and December; the rest of the year
// "Any occasion" and the occasion designs come next and the Christmas ones last.
export const DESIGNS = [
  { id: 'navy_gold', name: 'Navy and gold', christmas: false },
  { id: 'christmas_night', name: 'Christmas night', christmas: true },
  { id: 'wrapped_present', name: 'Wrapped present', christmas: true },
  { id: 'gold_foil', name: 'Gold foil', christmas: true },
  { id: 'black_gold', name: 'Black and gold', christmas: false },
  { id: 'any_occasion', name: 'Any occasion', christmas: false },
  { id: 'birthday_navy', name: 'Birthday balloons', christmas: false },
  { id: 'birthday_pink', name: 'Birthday cake', christmas: false },
  { id: 'for_him', name: 'For him', christmas: false },
  { id: 'anniversary', name: 'Anniversary', christmas: false },
  { id: 'new_baby', name: 'New baby', christmas: false },
]
export const isChristmasTime = (date = new Date()) => date.getMonth() >= 10
export function designsInOrder(date = new Date()) {
  if (isChristmasTime(date)) return DESIGNS
  const first = ['navy_gold', 'any_occasion', 'birthday_navy', 'birthday_pink', 'for_him', 'anniversary', 'new_baby', 'black_gold']
  return [...first.map(id => DESIGNS.find(design => design.id === id)), ...DESIGNS.filter(design => !first.includes(design.id))]
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

// "From Anna" under the message, unless the message already names the sender (as "Love, Anna x" does).
export function fromLine(from, message = '') {
  const name = (from || '').trim()
  if (!name) return ''
  return (message || '').toLowerCase().includes(name.toLowerCase()) ? '' : `From ${name}`
}

// When the sender's name changes after the message was edited, keep "Love, <name> x" in step with it.
export function renameSignOff(message, before, after) {
  const old = `Love, ${(before || '').trim() || '…'} x`
  return message.includes(old) ? message.replace(old, `Love, ${(after || '').trim() || '…'} x`) : message
}
export const MESSAGE_LIMIT = 400

// The line above the name on the voucher: Christmas words only on a Christmas design with a Christmas message.
export function kicker(design, message = '') {
  const christmasDesign = DESIGNS.find(item => item.id === design)?.christmas
  const christmasWords = /christmas|xmas|new year/i.test(message)
  if (design === 'gold_foil' || design === 'black_gold') return 'A special gift for'
  if (design === 'wrapped_present') return 'To'
  if (design === 'navy_gold') return 'A gift of wellness for'
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

// "Where do they live?" as a few cards, one tap each, built from the areas' charges:
//   Just the massage (+£0): the areas with no charge; anywhere else they pay that area's charge when they book.
//   A card for each lower charge (e.g. congestion £18): covers up to that amount, so those areas and the free ones.
//   Everything included (the highest charge): any of the areas.
const chargeWord = list => {
  const travel = list.some(a => Number(a.travel) > 0)
  const congestion = list.some(a => Number(a.congestion) > 0)
  return travel && congestion ? 'Travel and congestion' : travel ? 'Travel fee' : 'Congestion charge'
}
const orList = names => (names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0] || '')
export function travelTiers(options) {
  const areas = (options?.areas || []).map(a => ({ ...a, extra: (Number(a.travel) || 0) + (Number(a.congestion) || 0) }))
  const top = Number(options?.all_areas_cover) || 0
  const free = areas.filter(a => a.extra === 0).map(a => a.name)
  const tiers = [{ key: 'none', choice: 'none', cover: 0, title: 'Just the massage', names: free }]
  const lower = [...new Set(areas.map(a => a.extra).filter(x => x > 0 && x < top))].sort((a, b) => a - b)
  for (const amount of lower) {
    const these = areas.filter(a => a.extra === amount)
    tiers.push({ key: `upto-${amount}`, choice: 'upto', cover: amount, title: `${chargeWord(these)} included`, names: these.map(a => a.name), or: orList(these.map(a => a.name)) })
  }
  if (top > 0) tiers.push({ key: 'all', choice: 'all', cover: top, title: 'Everything included', charged: areaGroups(areas.filter(a => a.extra > 0)) })
  return tiers
}
// The words on the voucher and the booking for what a voucher covers besides the massage.
export function travelWords(voucher) {
  if (voucher.travel_choice === 'all') return 'Travel and congestion included, anywhere in my areas'
  if (voucher.travel_choice === 'upto') return `Travel and congestion included up to ${whole(voucher.travel_cover ?? voucher.travel_cover_gbp)}`
  if (voucher.travel_choice === 'area' && voucher.area_name) return `Travel to ${voucher.area_name} included`
  return ''
}

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

// The buying page's address, to share anywhere (WhatsApp, Instagram, a client's chat).
export const shopLink = origin => `${origin}/gift`

// The message that invites someone to buy a voucher: Christmas wording in November and December, a general one otherwise.
// {name} is the client's first name ("Hi Sarah!"), left out when there is none ("Hi!").
export function shopMessage(link, firstName = '', date = new Date()) {
  const name = String(firstName || '').trim()
  const hello = name ? `Hi ${name}!` : 'Hi!'
  const ask = isChristmasTime(date) ? 'Looking for a Christmas present?' : 'Looking for a present for someone special?'
  return `${hello} ${ask} You can now give a massage at home as a gift voucher. Choose the length, add your own message, and it arrives beautifully wrapped 🎁\n${link}\n\nWarm wishes,\nVadim`
}

export const londonDate = iso => (iso ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }).format(new Date(iso)) : '')
export const whole = amount => `£${Number(amount).toFixed(2).replace(/\.00$/, '')}`

// The areas grouped by what they add, for "Anywhere in my areas" and the voucher page: no charge first, then each charge, lowest first.
export function areaGroups(areas) {
  const groups = new Map()
  for (const area of areas || []) {
    const travel = Number(area.travel) || 0
    const congestion = Number(area.congestion) || 0
    const label = travel + congestion === 0 ? 'No extra charge'
      : [travel > 0 && `travel fee ${whole(travel)}`, congestion > 0 && `congestion charge ${whole(congestion)}`].filter(Boolean).join(' + ').replace(/^./, c => c.toUpperCase())
    const key = `${travel + congestion}|${label}`
    if (!groups.has(key)) groups.set(key, { label, extra: travel + congestion, names: [] })
    groups.get(key).names.push(area.name)
  }
  return [...groups.values()].sort((a, b) => a.extra - b.extra)
}

// A voucher can be refunded within this many days of buying, if unused (Vadim, 15 Nov 2026).
export const REFUND_DAYS = 14
