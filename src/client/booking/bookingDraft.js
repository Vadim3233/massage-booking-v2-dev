export const STEPS = ['Area', 'Treatment', 'Duration', 'Date & Time', 'Review', 'Your Details', 'Payment', 'Confirmation']

export function parseBookingStep(value) {
  if (value === null || value === undefined || value === '') return 0
  if (!/^\d+$/.test(String(value))) return 0
  const step = Number(value)
  return Number.isInteger(step) && step >= 0 && step < STEPS.length ? step : 0
}
export const draftKey = 'vad-v2-booking-draft-v1'
export const holdKey = 'vad-v2-hold-client-v1'
export const emptyDetails = { first_name: '', last_name: '', email: '', phone: '', savedAddressId: '', address_line_1: '', address_line_2: '', city: 'London', postcode: '', entry_instructions: '' }
export const newDraft = () => ({ areaId: '', serviceId: '', sessions: [], enhancementIds: [], date: '', start: null, hold: null, details: { ...emptyDetails }, note: '', paymentMethod: 'bank_transfer', pending: null, bookingId: null })
export const durationOf = (draft) => draft.sessions.reduce((sum, session) => sum + session.duration_minutes, 0)
export function validHold(hold) {
  return Boolean(
    hold &&
    typeof hold.hold_id === 'string' &&
    hold.hold_id &&
    typeof hold.hold_token === 'string' &&
    hold.hold_token &&
    Number.isFinite(Date.parse(hold.expires_at))
  )
}

export const activeHold = (draft, now = Date.now()) =>
  Boolean(validHold(draft.hold) && Date.parse(draft.hold.expires_at) > now)
export const newSession = (duration) => ({ duration_minutes: duration, recipient_name: '', preference_ids: [] })

function validPersistedSessions(sessions) {
  return Array.isArray(sessions) && sessions.every((session) =>
    session &&
    typeof session === 'object' &&
    [60, 90, 120].includes(Number(session.duration_minutes)) &&
    Array.isArray(session.preference_ids)
  )
}

export function browserClientKey(storage, uuid = () => crypto.randomUUID()) {
  let key = storage.getItem(holdKey)
  if (!key || !/^[A-Za-z0-9:_-]{20,120}$/.test(key)) {
    key = uuid()
    storage.setItem(holdKey, key)
  }
  return key
}

export function restoreDraft(storage) {
  try {
    const saved = JSON.parse(storage.getItem(draftKey))
    if (saved?.version === 1 && Array.isArray(saved.draft?.sessions)) {
      const draft = { ...newDraft(), ...saved.draft, details: { ...emptyDetails, ...saved.draft.details } }
      if (!validPersistedSessions(draft.sessions)) {
        draft.sessions = []
        draft.date = ''
        draft.start = null
        draft.hold = null
        draft.pending = null
        draft.bookingId = null
      } else if (draft.hold && !validHold(draft.hold)) {
        draft.hold = null
        draft.start = null
      }
      return draft
    }
  } catch { /* An unreadable UI draft is not a database fallback. */ }
  return newDraft()
}

export function validDetails(details) {
  return ['first_name', 'last_name', 'email', 'phone'].every((key) => details[key].trim()) &&
    (Boolean(details.savedAddressId) || ['address_line_1', 'city', 'postcode'].every((key) => details[key].trim()))
}

export function allowedStep(draft, requested, now = Date.now()) {
  if (draft.bookingId) return 7
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
