// The amounts of money in a message to a client, so they can be made to stand out: bold in WhatsApp (*£90.00*) and Telegram, bold and bigger
// in an email. An amount is a pound sign and a number, as the app and the database write them ("£90.00", "£1,234.00", "£90").
// An old price is left plain ("The price is now £180.00 (it was £150.00)", "… for £90 instead of £120", "previously £100"), so the one that stands out is always
// the one that counts.
const NUMBER = /£\d+(?:[.,]\d+)*/g
// A number written some other way ("£90.5", "£1,2345") is left alone rather than made partly bold.
const AMOUNT = /^£\d+(?:,\d{3})*(?:\.\d{2})?$/
const OLD_PRICE = /(?:\bwas|\binstead of|\busually|\bpreviously)\s*:?\s*$/i

// Where each amount to stand out sits in the text, as { start, end } (string indexes, which are what Telegram counts in).
export function amountRanges(text) {
  const value = String(text ?? '')
  const ranges = []
  for (const match of value.matchAll(NUMBER)) {
    if (!AMOUNT.test(match[0]) || OLD_PRICE.test(value.slice(Math.max(0, match.index - 20), match.index))) continue
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

// The text with each amount to stand out replaced by wrap(amount).
export function emphasiseAmounts(text, wrap) {
  const value = String(text ?? '')
  let out = ''
  let from = 0
  for (const { start, end } of amountRanges(value)) {
    out += value.slice(from, start) + wrap(value.slice(start, end))
    from = end
  }
  return out + value.slice(from)
}

// For WhatsApp: *£90.00* shows as bold.
export const whatsappBoldAmounts = text => emphasiseAmounts(text, amount => `*${amount}*`)

// For Telegram: bold "entities" to send beside the plain text, so nothing in the text itself has to change or be escaped. `limit` is where the
// text is cut, and an amount that does not fit whole is left out.
export const telegramBoldEntities = (text, limit = Infinity) => amountRanges(text)
  .filter(({ end }) => end <= limit)
  .map(({ start, end }) => ({ type: 'bold', offset: start, length: end - start }))
