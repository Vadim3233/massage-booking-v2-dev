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
})
