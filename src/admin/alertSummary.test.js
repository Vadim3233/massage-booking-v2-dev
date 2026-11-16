import { expect, it } from 'vitest'
import { shortMoney, summariseAlert } from './alertSummary.js'

const s = (title, body) => summariseAlert({ title, body })

it('turns the usual alerts into what happened, then who, which day and how much', () => {
  expect(s('Sabri Dylan would like to pay cash', '£188.00 for Fri 20 Nov at 14:30. Approve the request when you are happy to.'))
    .toEqual({ what: 'Wants to pay cash', kind: 'cash', who: 'Sabri Dylan · Fri 20 Nov', amount: '£188' })
  expect(s('Amelia Spence says the transfer is made', '£125.00 for Tue 17 Nov at 17:00. Check your bank, then verify the payment.'))
    .toEqual({ what: 'Transfer made', kind: 'bank', who: 'Amelia Spence · Tue 17 Nov', amount: '£125' })
  expect(s('New booking request', 'Alex Brannan: Wed 21 Oct at 18:30, 90 minutes, £125.00. Waiting for payment.'))
    .toEqual({ what: 'New booking request', kind: 'booking', who: 'Alex Brannan · Wed 21 Oct', amount: '£125' })
  expect(s('Jeannie Yoon booked another session', 'Sun 13 Dec at 17:00, 90 minutes, £125.00. Confirmed automatically, to be paid after their session on Sun 6 Dec at 17:00.'))
    .toMatchObject({ what: 'Booked another session', who: 'Jeannie Yoon · Sun 13 Dec', amount: '£125' })
  expect(s('Sonia Garcia Bejarano cancelled', 'Tue 3 Nov at 15:30 (£90.00). No late fee.')).toMatchObject({ what: 'Cancelled', kind: 'cancel', who: 'Sonia Garcia Bejarano · Tue 3 Nov', amount: '£90' })
})
it('names the new day of a moved appointment, and the buyer of a gift voucher', () => {
  expect(s('Sam Lee moved their appointment', 'From Tue 3 Nov at 15:30 to Thu 5 Nov at 10:00 (£90.00).')).toMatchObject({ what: 'Moved their appointment', who: 'Sam Lee · Thu 5 Nov' })
  expect(s('New gift voucher: £105.00 by bank transfer', 'Sonia Garcia Bejarano is buying a 60-minute massage for Sonia. Reference GIFT-T9H63.'))
    .toEqual({ what: 'New gift voucher', kind: 'gift', who: 'Sonia Garcia Bejarano · bank transfer', amount: '£105' })
  expect(s('Mia says the gift voucher transfer is made', '')).toMatchObject({ what: 'Gift voucher transfer made', kind: 'gift', who: 'Mia' })
})
it('keeps the versions of a new booking request, and any alert it does not know, as they are', () => {
  expect(s('New booking request, outside your areas', 'Kim Park: Mon 16 Nov at 10:00, 60 minutes, £90.00.')).toMatchObject({ what: 'New booking request, outside your areas', who: 'Kim Park · Mon 16 Nov' })
  expect(s('Is this the same person?', 'Alison (has a login) and Alison (added by you) have the same phone number.')).toEqual({ what: 'Is this the same person?', kind: 'people', who: '', amount: '' })
  expect(s('A time may have opened up', 'Something £5')).toEqual({ what: 'A time may have opened up', kind: 'other', who: '', amount: '' })
  expect(s(' cancelled', '')).toMatchObject({ kind: 'other' })
  expect(summariseAlert(null)).toMatchObject({ what: 'Alert' })
  expect(shortMoney('£108.50')).toBe('£108.50')
})
