export const STEPS = ['Area', 'Treatment', 'People & length', 'Date & Time', 'Review', 'Your Details', 'Payment', 'Confirmation']
export const draftKey = 'vad-v2-booking-draft-v1'
export const holdKey = 'vad-v2-hold-client-v1'
// The address is one text (ADR-059): whatever the client writes or pastes.
export const emptyDetails = { first_name: '', last_name: '', email: '', phone: '', savedAddressId: '', address: '', entry_instructions: '' }
export const newDraft = () => ({ areaId: '', serviceId: '', sessions: [], enhancementIds: [], date: '', start: null, hold: null, details: { ...emptyDetails }, note: '', paymentMethod: 'bank_transfer', pending: null, bookingId: null })
export const durationOf = (draft) => draft.sessions.reduce((sum, session) => sum + session.duration_minutes, 0)
export const activeHold = (draft, now = Date.now()) => Boolean(draft.hold && Date.parse(draft.hold.expires_at) > now)
export const newSession = (duration) => ({ duration_minutes: duration, recipient_name: '', preference_ids: [] })

export function browserClientKey(storage, uuid = () => crypto.randomUUID()) {
  let key = storage.getItem(holdKey)
  if (!key || !/^[A-Za-z0-9:_-]{20,120}$/.test(key)) {
    key = uuid()
    storage.setItem(holdKey, key)
  }
  return key
}

// A draft saved before the address was one box has it in four: they are put together, so nothing that was typed is lost. (The city alone, which
// started as London, is not an address.)
export function migrateDetails(details = {}) {
  const { address_line_1: line1, address_line_2: line2, city, postcode, ...rest } = details
  const typed = String(line1 ?? '').trim() || String(postcode ?? '').trim()
  const joined = typed ? [line1, line2, city, postcode].map((part) => String(part ?? '').trim()).filter(Boolean).join(', ') : ''
  return { ...emptyDetails, ...rest, address: rest.address || joined }
}

export function restoreDraft(storage) {
  try {
    const saved = JSON.parse(storage.getItem(draftKey))
    if (saved?.version === 1 && Array.isArray(saved.draft?.sessions)) {
      return { ...newDraft(), ...saved.draft, details: migrateDetails(saved.draft.details) }
    }
  } catch { /* An unreadable UI draft is not a database fallback. */ }
  return newDraft()
}

// A phone number that cannot be right: I ring this number. Empty fields are asked for separately; this is only about what has been typed. (An address is
// not judged: it is one text, and only the client knows whether it is complete. A missing postcode is a gentle note on the screen, never a stop.)
export function detailProblems(details) {
  const problems = {}
  const digits = String(details.phone || '').replace(/\D/g, '')
  if (details.phone?.trim() && (digits.length < 7 || digits.length > 20)) problems.phone = "That number doesn't look right. Please check it, so I can reach you."
  return problems
}

export function validDetails(details) {
  return ['first_name', 'last_name', 'email', 'phone'].every((key) => details[key].trim()) &&
    (Boolean(details.savedAddressId) || Boolean(details.address.trim()))
}

// A saved address fills these boxes on the details screen; "Enter an address" leaves them empty, as they start.
const ADDRESS_BOXES = ['address', 'entry_instructions']
export const addressFields = (address) => Object.fromEntries(ADDRESS_BOXES.map((key) => [key, address[key] || '']))
export const blankAddressFields = () => Object.fromEntries(ADDRESS_BOXES.map((key) => [key, emptyDetails[key]]))
// The address a client is offered straight away: the one marked as theirs by default (the first they booked, kept as "Home"), or their only
// address when none is marked. With several and none marked, nothing is chosen for them.
export const usualAddress = (addresses) => addresses.find((address) => address.is_default) || (addresses.length === 1 ? addresses[0] : null)
// Whether the client has already put an address into the boxes themselves.
export const addressTyped = (details) => ADDRESS_BOXES.some((key) => details[key]?.trim())

// Whether the name and phone are all there. A returning client's details are then shown locked, so nothing is changed by accident.
export const contactComplete = (details) => ['first_name', 'last_name', 'phone'].every((key) => details[key]?.trim())

export function allowedStep(draft, requested, now = Date.now()) {
  if (draft.bookingId) return draft.paymentComplete === false ? 6 : 7
  if (draft.pending) return 6
  let maximum = 0
  if (draft.areaId) maximum = 1
  if (maximum === 1 && draft.serviceId) maximum = 2
  if (maximum === 2 && durationOf(draft) > 0) maximum = 3
  if (maximum === 3 && activeHold(draft, now)) maximum = 5
  if (maximum === 5 && validDetails(draft.details)) maximum = 6
  return Math.min(Math.max(0, requested), maximum)
}

export function londonDate(offset = 0, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  const date = new Date(`${value.year}-${value.month}-${value.day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

export const money = (amount) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(amount)
export const timeLabel = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
export const dateLabel = (date) => date ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeZone: 'Europe/London' }).format(new Date(`${date}T12:00:00Z`)) : ''
