import { today } from './calendarPresentation.js'

export const draftKey = ownerId => `admin-new-booking:v1:${ownerId}`
export function emptyAdminDraft(initialDate) {
  return {
    client: null,
    details: { savedAddressId: '', address_line_1: '', address_line_2: '', city: '', postcode: '', entry_instructions: '' },
    areaId: '', serviceId: '', sessions: [{ duration_minutes: 60, recipient_name: '', preference_ids: [] }],
    enhancementIds: [], date: initialDate || today(), start: null, payment: 'bank_pending', note: '', repeat: { on: false, endDate: '' }, submission: null,
  }
}
export function meaningfulDraft(draft) {
  return Boolean(draft.client || draft.serviceId || draft.areaId || draft.note || draft.details.address_line_1 || draft.submission || Object.values(draft.newClient || {}).some(Boolean))
}
export function loadAdminDraft(ownerId, initialDate) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(draftKey(ownerId)))
    if (saved?.version === 1 && Array.isArray(saved.draft?.sessions) && saved.draft?.details) {
      return { ...emptyAdminDraft(initialDate), ...saved.draft }
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
