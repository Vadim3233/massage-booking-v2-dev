import { today } from './calendarPresentation.js'

export const draftKey = ownerId => `admin-new-booking:v1:${ownerId}`
export function emptyAdminDraft(initialDate) {
  const date = initialDate || today()
  return {
    client: null,
    details: { savedAddressId: '', address_line_1: '', address_line_2: '', city: '', postcode: '', entry_instructions: '' },
    areaId: '', serviceId: '', sessions: [{ duration_minutes: 60, recipient_name: '', preference_ids: [] }],
    // Starting from a day that has gone (she was looking at it in the calendar) means recording something that already happened.
    enhancementIds: [], date, start: null, anyTime: false, anyTimeNotes: [], past: date < today(), payment: 'bank_pending', note: '', repeat: { on: false, endDate: '' }, submission: null,
  }
}
export function meaningfulDraft(draft) {
  return Boolean(draft.client || draft.serviceId || draft.areaId || draft.note || draft.details.address_line_1 || draft.submission || Object.values(draft.newClient || {}).some(Boolean))
}
export function loadAdminDraft(ownerId, initialDate) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(draftKey(ownerId)))
    if (saved?.version === 1 && Array.isArray(saved.draft?.sessions) && saved.draft?.details) {
      const merged = { ...emptyAdminDraft(initialDate), ...saved.draft }
      // A draft with nothing in it that is worth keeping (no client, treatment, area or note: only a day or a time was touched) is not brought back,
      // so New booking starts from the day it was opened from, and a day or "already happened" left over from an earlier visit cannot follow her.
      if (!meaningfulDraft(merged)) return emptyAdminDraft(initialDate)
      // A draft kept from before "It has already happened" existed has no such choice: it follows the day that draft is for, not the day New booking
      // was opened from this time (which would give a ticked box with a day still to come).
      const dated = saved.draft.past === undefined ? { ...merged, past: merged.date < today() } : merged
      // Something that has already happened is never a repeating booking, and its screen has no repeat choice to show that one was left on.
      const draft = dated.past && dated.repeat?.on ? { ...dated, repeat: { ...dated.repeat, on: false } } : dated
      // A time outside the usual ones was chosen against the diary as it was then, with reasons written for it; it is chosen again rather than
      // trusted (unless a booking is already being made, which keeps its own request).
      return draft.anyTime && !draft.submission ? { ...draft, start: null, anyTime: false, anyTimeNotes: [] } : draft
    }
  } catch { /* Storage can be unavailable; the in-memory draft remains usable. */ }
  return emptyAdminDraft(initialDate)
}
export function saveAdminDraft(ownerId, draft) {
  try { sessionStorage.setItem(draftKey(ownerId), JSON.stringify({ version: 1, draft })) } catch { /* No secrets; memory remains available. */ }
}
export function clearAdminDraft(ownerId) {
  try { sessionStorage.removeItem(draftKey(ownerId)) } catch { /* Storage may be disabled. */ }
}
// A client who has just been deleted must not linger in a half-made booking: a saved draft for that client is dropped.
export function forgetDraftFor(ownerId, clientId) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(draftKey(ownerId)))
    if (clientId && saved?.draft?.client?.id === clientId) sessionStorage.removeItem(draftKey(ownerId))
  } catch { /* Storage may be unavailable, or hold something else; there is nothing to forget. */ }
}
