import { describe, expect, it } from 'vitest'
import { barDescription, barLabel, comparisonText, csvFileName, incomeCsv, nextAnchor, periodLabel, previousAnchor, rowNote, rowWhen, stillToComeText } from './incomePresentation.js'

const summary = changes => ({ kind: 'month', from: '2026-10-01', to: '2026-10-31', change_percent: 12, still_to_come_gbp: 520, ...changes })

describe('the Income screen in words', () => {
  it('names each kind of period', () => {
    expect(periodLabel(summary({ kind: 'week', from: '2026-10-19', to: '2026-10-25' }))).toBe('19 Oct – 25 Oct 2026')
    expect(periodLabel(summary({ kind: 'week', from: '2026-12-28', to: '2027-01-03' }))).toBe('28 Dec 2026 – 3 Jan 2027')
    expect(periodLabel(summary())).toBe('October 2026')
    expect(periodLabel(summary({ kind: 'year', from: '2026-01-01', to: '2026-12-31' }))).toBe('2026')
    expect(periodLabel(summary({ kind: 'tax_year', from: '2026-04-06', to: '2027-04-05' }))).toBe('Tax year 2026/27')
  })
  it('moves the arrows to the day before or after the period', () => {
    expect(previousAnchor(summary())).toBe('2026-09-30')
    expect(nextAnchor(summary())).toBe('2026-11-01')
    expect(nextAnchor(summary({ kind: 'tax_year', from: '2026-04-06', to: '2027-04-05' }))).toBe('2027-04-06')
  })
  it('compares with the period before, and says — when that brought nothing', () => {
    expect(comparisonText(summary())).toBe('+12% vs last month')
    expect(comparisonText(summary({ kind: 'week', change_percent: -5 }))).toBe('-5% vs last week')
    expect(comparisonText(summary({ kind: 'tax_year', change_percent: 0 }))).toBe('0% vs last tax year')
    expect(comparisonText(summary({ change_percent: null }))).toBe('—')
  })
  it('says what is still to come only when there is some', () => {
    expect(stillToComeText(summary())).toBe('£520.00 still to come this month')
    expect(stillToComeText(summary({ still_to_come_gbp: 0 }))).toBe('')
    expect(stillToComeText(summary({ still_to_come_gbp: null }))).toBe('')
  })
  it('names the bars, short on screen and in full for a screen reader', () => {
    expect(barLabel('week', { from: '2026-10-19' })).toBe('Mon')
    expect(barLabel('month', { from: '2026-10-19' })).toBe('19 Oct')
    expect(barLabel('year', { from: '2026-01-01' })).toBe('Jan')
    expect(barDescription('month', { from: '2026-10-19', to: '2026-10-25', total_gbp: '520.00' })).toBe('19 Oct – 25 Oct: £520.00')
    expect(barDescription('tax_year', { from: '2026-04-06', to: '2026-04-30', total_gbp: 0 })).toBe('April: £0.00')
  })
  it('describes each booking in the list', () => {
    const row = { date: '2026-10-19', start_minutes: 600, method: 'bank_transfer', refund_gbp: '70.00', late_fee_gbp: 0 }
    expect(rowWhen(row)).toBe('Mon 19 Oct, 10:00')
    expect(rowNote(row)).toBe('Bank transfer · refund £70.00 sent')
    expect(rowNote({ ...row, method: 'cash', refund_gbp: 0, late_fee_gbp: '100.00' })).toBe('Cash · late fee')
  })
  it('makes the accountant\'s file: one row per booking, safe for commas and quotes', () => {
    const csv = incomeCsv([
      { date: '2026-10-19', booking_reference: 'VM-1', client_name: 'Smith, "Jo"', method: 'cash', received_gbp: '90.00', refund_gbp: '0.00', net_gbp: '90.00' },
      { date: '2026-10-20', booking_reference: 'VM-2', client_name: null, method: 'bank_transfer', received_gbp: 100, refund_gbp: 70, net_gbp: 30 },
    ])
    expect(csv.split('\r\n')).toEqual([
      'Date,Booking reference,Client,Method,Amount received,Refund,Net',
      '2026-10-19,VM-1,"Smith, ""Jo""",Cash,90.00,0.00,90.00',
      '2026-10-20,VM-2,,Bank transfer,100.00,70.00,30.00',
      '',
    ])
    expect(csvFileName(summary())).toBe('vadmassage-income-2026-10.csv')
    expect(csvFileName(summary({ kind: 'tax_year', from: '2026-04-06', to: '2027-04-05' }))).toBe('vadmassage-income-tax-year-2026-27.csv')
  })
})
