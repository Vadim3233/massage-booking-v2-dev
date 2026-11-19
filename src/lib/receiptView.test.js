import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as lib from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { buildReceiptPdf, FONT_FILES, wrapText } from './receiptPdf.js'
import { receiptView } from './receiptView.js'

const business = {
  name: 'VAD Soft Tissue & Massage Therapy', tagline: 'Professional Massage & Soft Tissue Therapy', website: 'vadmassage.com', phone: '07700 900123',
  practitioner_name: 'Vadim Susarin', practitioner_title: 'Level 5 Soft Tissue Therapist', association: 'Institute for Soft Tissue Therapists (ISRM)', membership_number: '9555',
}
const receipt = (changes = {}) => ({
  number: 'VAD-2026-0001',
  standing: { status: 'paid' },
  snapshot: {
    number: 'VAD-2026-0001', issued_on: '2026-10-30', business, billed_to: 'Alex Morgan', reference: 'VM-7K3Q',
    appointment: { date: '2026-10-12', start_minutes: 600, duration_minutes: 60 },
    treatments: [{ name: 'Massage Therapy', duration_minutes: 60, recipient: 'Alex Morgan' }],
    lines: [{ label: 'Massage Therapy, 60 minutes', amount: 90 }, { label: 'Travel, Hillingdon', amount: 10 }],
    total: 100, payment: { method: 'bank_transfer', paid_at: '2026-10-12T09:00:00Z', amount: 100 },
  },
  ...changes,
})

describe('what a receipt PDF says', () => {
  it('shows the treatment, the payment and the practitioner\'s credentials', () => {
    const view = receiptView(receipt())
    expect(view).toMatchObject({
      number: 'VAD-2026-0001', issuedOn: '30 October 2026', stamp: 'PAID', notice: null, client: 'Alex Morgan', treatmentDate: '12 October 2026',
      treatments: [{ name: 'Massage Therapy', duration: '60 minutes' }], total: '£100.00', paid: '£100.00', method: 'Bank transfer', paidOn: '12 October 2026',
      credentials: { name: 'Vadim Susarin', title: 'Level 5 Soft Tissue Therapist', association: 'Institute for Soft Tissue Therapists (ISRM)', number: '9555' },
      fileName: 'Receipt VAD-2026-0001.pdf',
    })
    expect(view.lines).toEqual([{ label: 'Massage Therapy, 60 minutes', amount: '£90.00' }, { label: 'Travel, Hillingdon', amount: '£10.00' }])
    expect(view.business.contact).toBe('07700 900123  ·  vadmassage.com')
  })
  it('never says PAID once the payment was refunded, or the booking cancelled or missed', () => {
    const refunded = receiptView(receipt({ standing: { status: 'refunded', refunded_at: '2026-10-20T10:00:00Z', refunded_gbp: 100 } }))
    expect(refunded.stamp).toBe('REFUNDED')
    expect(refunded.notice).toBe('This payment was refunded on 20 October 2026 (£100.00). This receipt is kept as a record and is no longer proof of payment.')
    for (const [status, words] of [['cancelled', 'This booking was cancelled'], ['missed', 'This appointment was marked as missed'], ['unpaid', 'This payment is no longer marked as received']]) {
      const view = receiptView(receipt({ standing: { status } }))
      expect(view.stamp).toBe('VOID')
      expect(view.notice).toBe(`${words} after the receipt was issued. It is kept as a record and is no longer proof of payment.`)
    }
  })
  it('lists each person\'s treatment when one booking was for two people', () => {
    const two = receipt()
    two.snapshot.treatments = [{ name: 'Massage Therapy', duration_minutes: 60, recipient: 'Alex Morgan' }, { name: 'Deep Tissue Massage', duration_minutes: 60, recipient: 'Sam Morgan' }]
    const view = receiptView(two)
    expect(view.showRecipients).toBe(true)
    expect(view.treatments.map(item => item.recipient)).toEqual(['Alex Morgan', 'Sam Morgan'])
  })
  it('reads a receipt made before treatments and credentials were kept on it', () => {
    const old = receipt({ number: 'VM-2026-0003' })
    delete old.snapshot.treatments
    old.snapshot.business = { name: 'VadMassage', phone: '07700 900123' }
    const view = receiptView(old)
    expect(view.treatments).toEqual([{ name: 'Massage Therapy', duration: '60 minutes', recipient: '' }])
    expect(view.credentials).toBeNull()
  })
})

describe('the PDF itself', () => {
  const fonts = Object.fromEntries(Object.entries(FONT_FILES).map(([role, path]) => [role, readFileSync(`public${path}`)]))
  it('is one A4 page, titled with the receipt number', async () => {
    const bytes = await buildReceiptPdf(receiptView(receipt()), { lib, fontkit, fonts })
    const doc = await lib.PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
    expect(doc.getPage(0).getSize()).toEqual({ width: 595.28, height: 841.89 })
    expect(doc.getTitle()).toBe('Payment receipt VAD-2026-0001')
  })
  it('handles names with accents, and long words that do not fit a line', async () => {
    const accented = receipt()
    accented.snapshot.billed_to = 'Zoë Łukasiewicz-Ó Briain'
    await expect(buildReceiptPdf(receiptView(accented), { lib, fontkit, fonts })).resolves.toBeInstanceOf(Uint8Array)
    const doc = await lib.PDFDocument.create()
    doc.registerFontkit(fontkit)
    const font = await doc.embedFont(fonts.body)
    const lines = wrapText('a'.repeat(300), font, 10, 100)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.every(line => font.widthOfTextAtSize(line, 10) <= 100)).toBe(true)
  })
  it('draws a gift voucher receipt and a session paid with a voucher', async () => {
    for (const r of [voucherReceipt(), giftSession()]) {
      const doc = await lib.PDFDocument.load(await buildReceiptPdf(receiptView(r), { lib, fontkit, fonts }))
      expect(doc.getPageCount()).toBe(1)
    }
    expect((await lib.PDFDocument.load(await buildReceiptPdf(receiptView(voucherReceipt()), { lib, fontkit, fonts }))).getTitle()).toBe('Gift voucher receipt GV-2026-0007')
  })
})

const voucherReceipt = (standing = { status: 'paid' }) => ({
  number: 'GV-2026-0007', standing,
  snapshot: {
    kind: 'gift_voucher', number: 'GV-2026-0007', issued_on: '2026-12-03', business, billed_to: 'Sarah Collins', buyer_email: 'sarah@example.com', reference: 'GIFT-7K3MQ',
    voucher: { for: 'Anna', from: 'Sarah', gift: 'a 90-minute massage', code_end: 'QX9P', expires_at: '2027-12-03T23:59:59Z' },
    lines: [{ label: 'A 90-minute massage', amount: 110 }, { label: 'Travel and congestion charge, any area', amount: 20 }],
    total: 130, payment: { method: 'bank_transfer', paid_at: '2026-12-03T10:00:00Z', amount: 130 },
  },
})
const giftSession = () => receipt({ snapshot: { ...receipt().snapshot, total: 100, payment: { method: 'bank_transfer', paid_at: '2026-10-12T09:00:00Z', amount: 0 }, gift: { covered: 100, code_end: 'QX9P' } } })

describe('gift voucher receipts (20261221100000)', () => {
  it('a voucher receipt names the buyer and the person, and only the end of the code', () => {
    const view = receiptView(voucherReceipt())
    expect(view).toMatchObject({ kind: 'gift_voucher', title: 'Gift Voucher Receipt', stamp: 'PAID', referenceLabel: 'Reference', reference: 'GIFT-7K3MQ', total: '£130.00', paid: '£130.00', fileName: 'Gift voucher receipt GV-2026-0007.pdf' })
    expect(view.leftRows).toEqual([['Name', 'Sarah Collins'], ['Email', 'sarah@example.com']])
    expect(view.rightRows).toContainEqual(['Code', 'ending QX9P'])
    expect(view.rightRows).toContainEqual(['Gift', 'A 90-minute massage'])
    expect(view.footnote).toMatch(/not for a treatment/)
  })
  it('a refunded voucher receipt is stamped REFUNDED with the amount', () => {
    const view = receiptView(voucherReceipt({ status: 'refunded', refunded_at: '2026-12-10T10:00:00Z', refunded_gbp: 50 }))
    expect(view.stamp).toBe('REFUNDED')
    expect(view.notice).toMatch(/refunded on 10 December 2026 \(£50\.00\)/)
  })
  it('a session paid with a voucher shows what the voucher paid and what the client paid', () => {
    const view = receiptView(giftSession())
    expect(view.gift).toEqual({ covered: '£100.00', ending: 'QX9P', yours: '£0.00' })
    expect(view.method).toBe('Gift voucher')
  })
  it('after the booking was made cheaper than the voucher, the voucher part is what the client did not pay', () => {
    const edited = giftSession()
    edited.snapshot = { ...edited.snapshot, total: 90, gift: { covered: 125, code_end: 'QX9P' } }
    expect(receiptView(edited).gift).toEqual({ covered: '£90.00', ending: 'QX9P', yours: '£0.00' })
  })
})
