export const emptyAddress = { savedAddressId: '', address: '', entry_instructions: '' }
export const clientLabel = client => [client?.first_name, client?.last_name].filter(Boolean).join(' ') || 'Client'
// Two letters to tell clients apart at a glance.
export const initials = client => ([client?.first_name, client?.last_name].filter(Boolean).map(part => part.trim()[0]).join('').slice(0, 2) || '?').toUpperCase()
export const PAYMENT_OPTIONS = [['bank_pending', 'Bank transfer — payment pending'], ['bank_received', 'Bank transfer — already received'], ['cash_appointment', 'Cash — at appointment'], ['cash_received', 'Cash — already received']]
// For an appointment that has already happened: paid either way, or not paid yet (and how it will be paid, so that when it is, it is recorded as
// what it was). Each is an arrangement the database already knows, with the same meaning as on a booking for the future.
export const PAST_PAYMENT_OPTIONS = [['bank_received', 'Paid by bank transfer'], ['cash_received', 'Paid in cash'], ['bank_pending', 'Not paid yet — bank transfer'], ['cash_appointment', 'Not paid yet — cash']]
export const isPaidArrangement = payment => payment === 'bank_received' || payment === 'cash_received'
// What recording a past appointment does, in the words used on the screen: paid ones are completed at once, the others stay confirmed.
export const pastOutcome = payment => (isPaidArrangement(payment)
  ? 'It will be recorded as completed, and the client is not emailed.'
  : 'It will be recorded as confirmed, and you can complete it once it is paid. The client is not emailed.')
// "Wednesday 7 October 2026". Built from its parts, so no punctuation depends on the language data of the browser or of Node.
export function dayInWords(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    .formatToParts(new Date(`${date}T12:00:00Z`)).map(part => [part.type, part.value]))
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}`
}
// The question put to her before a PAID past appointment is recorded: completed is final from here (it cannot be cancelled, moved or marked as
// missed afterwards), so it names who, which day (with the year), when and how much, and says so.
export function pastQuestion({ who, date, start, minutes, total, payment }) {
  const day = dayInWords(date)
  const clock = minutesOfDay => `${String(Math.floor(minutesOfDay / 60)).padStart(2, '0')}:${String(minutesOfDay % 60).padStart(2, '0')}`
  const how = payment === 'cash_received' ? 'paid in cash' : 'paid by bank transfer'
  return `Record this as completed and paid?\n\n${who}\n${day}, ${clock(start)}–${clock(start + minutes)}\n${total === null ? '' : `${total}, `}${how}\n\nA completed appointment cannot be cancelled or changed from here, so please check the client and the day.`
}

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
