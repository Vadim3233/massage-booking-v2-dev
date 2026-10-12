export const emptyAddress = { savedAddressId: '', address_line_1: '', address_line_2: '', city: 'London', postcode: '', entry_instructions: '' }
export const clientLabel = client => [client?.first_name, client?.last_name].filter(Boolean).join(' ') || 'Client'
export const PAYMENT_OPTIONS = [['bank_pending', 'Bank transfer — payment pending'], ['bank_received', 'Bank transfer — already received'], ['cash_appointment', 'Cash — at appointment'], ['cash_received', 'Cash — already received']]

// What a client usually books, taken from their last booking, so a regular needs only a time. Fills only what is still empty.
export function defaultsFromLast(draft, catalogue, last) {
  const change = {}
  const first = [...(last?.booking_sessions || [])].sort((a, b) => a.position - b.position)[0]
  const serviceId = draft.serviceId
    || (first && catalogue.services.some(service => service.id === first.service_id) ? first.service_id : '')
    || catalogue.services.find(service => /^massage$/i.test(service.name))?.id || ''
  if (!draft.serviceId && serviceId) change.serviceId = serviceId
  const onlyDefaultSession = draft.sessions.length === 1 && draft.sessions[0].duration_minutes === 60 && draft.start === null
  if (first && serviceId && onlyDefaultSession && first.duration_minutes !== 60
    && catalogue.prices.some(price => price.service_id === serviceId && price.duration_minutes === first.duration_minutes)) {
    change.sessions = [{ ...draft.sessions[0], duration_minutes: first.duration_minutes }]
  }
  if (!draft.areaId && last?.service_area_id && catalogue.areas.some(area => area.id === last.service_area_id)) change.areaId = last.service_area_id
  if (draft.payment === 'bank_pending' && last?.booking_payments?.method === 'cash') change.payment = 'cash_appointment'
  return change
}
