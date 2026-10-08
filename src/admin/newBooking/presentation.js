export const emptyAddress = { savedAddressId: '', address_line_1: '', address_line_2: '', city: 'London', postcode: '', entry_instructions: '' }
export const clientLabel = client => [client?.first_name, client?.last_name].filter(Boolean).join(' ') || 'Client'
export const PAYMENT_OPTIONS = [['bank_pending', 'Bank transfer — payment pending'], ['bank_received', 'Bank transfer — already received'], ['cash_appointment', 'Cash — at appointment'], ['cash_received', 'Cash — already received']]
