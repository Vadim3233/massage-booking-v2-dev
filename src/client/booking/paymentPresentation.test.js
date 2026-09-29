import { it, expect } from 'vitest'
import { formatPostcode, paymentStatus } from './paymentPresentation.js'
it.each([['sw1a1aa','SW1A 1AA'],[' w1a  0ax ','W1A 0AX'],['gir0aa','GIR 0AA']])('formats %s for display', (input,expected) => expect(formatPostcode(input)).toBe(expected))
it('uses explicit client-friendly payment wording', () => {
 expect(paymentStatus({booking_payments:{status:'awaiting_transfer'}})).toBe('Awaiting your bank transfer')
 expect(paymentStatus({booking_payments:{status:'awaiting_verification'}})).toBe('Transfer declared — awaiting verification')
 expect(paymentStatus({reservation_expired:true,booking_payments:{status:'awaiting_transfer'}})).toBe('Reservation expired')
})
