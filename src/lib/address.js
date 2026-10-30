// An address is one text: whatever was written or pasted, with its line breaks turned into commas (ADR-059). These only READ an address; the database
// keeps it tidy and is the one that decides what is stored.

// The longest an address can be (the database refuses more).
export const MAX_ADDRESS = 400

// A UK postcode inside a longer text, in any capitals and with or without the space ("sw31aa", "SW3 1AA").
const POSTCODE = /\b([A-Za-z]{1,2}\d[A-Za-z\d]?)\s*(\d[A-Za-z]{2})\b/

// The same tidying the database does: line breaks become commas, runs of spaces become one, doubled commas become one, and commas and spaces at either end go.
export const tidyAddress = text => String(text ?? '').replace(/[\r\n]+/g, ',').replace(/\s+/g, ' ').replace(/(\s*,\s*)+/g, ', ').replace(/^[ ,]+|[ ,]+$/g, '')

// The postcode inside an address, written as postcodes are ("sw31aa" becomes "SW3 1AA"), or nothing when there is none.
export function postcodeOf(address) {
  const match = POSTCODE.exec(String(address ?? ''))
  return match ? `${match[1]} ${match[2]}`.toUpperCase() : ''
}

// Where an appointment is, in a few characters, for a card: its postcode, or else the last part of the address (usually the town).
export function shortWhere(address) {
  const code = postcodeOf(address)
  if (code) return code
  const last = tidyAddress(address).split(',').pop().trim()
  return last.length > 28 ? `${last.slice(0, 27)}…` : last
}

// A gentle note for a client who has typed an address with no postcode in it. It never stops them: only they know whether it is complete.
export const NO_POSTCODE_NOTE = "I can't see a postcode in that address. It helps me find you, so add it if you have it."
// The same, for the Admin typing a client's address: the postcode is what the day's cards show.
export const NO_POSTCODE_NOTE_ADMIN = "There is no postcode in that address. Add it if you have it: it is what the day's cards show."
export const needsPostcodeNote = address => Boolean(String(address ?? '').trim()) && !postcodeOf(address)

// The area a postcode is in, from the areas' lists of postcodes ("SW3", "W1", or a sector such as "W2 1"): the sector first, then the district, then
// the district without its last letter, so "W1K 1PN" is found by "W1". The same rule as public.postcode_area in the database, which is what decides.
// `areas` are the areas clients can choose; null when the postcode is in none of them.
export function areaForPostcode(areas, postcode) {
  const code = postcodeOf(postcode)
  if (!code) return null
  const [outward, inward] = code.split(' ')
  const wanted = [`${outward} ${inward[0]}`, outward, ...(/\d[A-Z]$/.test(outward) ? [outward.slice(0, -1)] : [])]
  for (const piece of wanted) {
    const area = areas.find(item => (item.postcodes || []).includes(piece))
    if (area) return area
  }
  return null
}

// Whether the areas have postcodes at all: until they do, nothing is checked.
export const areasHavePostcodes = areas => areas.some(area => (area.postcodes || []).length > 0)

// What a client is told about their postcode, or nothing when it is fine (or nothing is checked yet). `area` is the area they chose.
// 'other' stops them (the database would refuse the booking); 'outside' and 'none' let them carry on, and the booking waits for Vad.
export function postcodeCheck(areas, area, address) {
  if (!areasHavePostcodes(areas) || !String(address ?? '').trim()) return null
  const code = postcodeOf(address)
  if (!code) return { kind: 'none' }
  const found = areaForPostcode(areas, code)
  if (!found) return { kind: 'outside', postcode: code }
  if (area && found.id !== area.id) return { kind: 'other', postcode: code, area: found }
  return null
}
