// What a receipt says, worked out once from the receipt the database keeps, for the PDF the Admin and the client download.
// Everything here comes from the receipt itself (its saved copy of the booking and her details), so a receipt reads the same
// whenever it is downloaded, and nothing on it changes when a booking or her details change later.

const money = value => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(value))
const longDay = value => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }).format(new Date(value))
// A calendar date ("2026-10-12") is that day wherever it is read, so it is read at midday London time.
const calendarDay = date => longDay(`${date}T12:00:00Z`)
const METHODS = { bank_transfer: 'Bank transfer', cash: 'Cash', card: 'Card' }
const methodLabel = method => METHODS[method] || (method ? method[0].toUpperCase() + method.slice(1).replace(/_/g, ' ') : 'Not recorded')
const minutes = value => `${value} minutes`

// A receipt is kept whatever happens later. When it no longer shows money received, the PDF says so instead of PAID.
function standingWords(standing) {
  const status = standing?.status || 'paid'
  if (status === 'paid') return { status, stamp: 'PAID', notice: null }
  if (status === 'refunded') {
    const when = standing.refunded_at ? ` on ${longDay(standing.refunded_at)}` : ''
    const amount = standing.refunded_gbp != null ? ` (${money(standing.refunded_gbp)})` : ''
    return { status, stamp: 'REFUNDED', notice: `This payment was refunded${when}${amount}. This receipt is kept as a record and is no longer proof of payment.` }
  }
  const why = { cancelled: 'This booking was cancelled', missed: 'This appointment was marked as missed', unpaid: 'This payment is no longer marked as received' }[status]
    || 'This receipt no longer stands'
  return { status, stamp: 'VOID', notice: `${why} after the receipt was issued. It is kept as a record and is no longer proof of payment.` }
}

// The treatments as booked. A receipt made before treatments were kept on it has only its price lines, so the first line stands in.
function treatmentsOf(snapshot) {
  const kept = Array.isArray(snapshot.treatments) ? snapshot.treatments : []
  if (kept.length) return kept.map(item => ({ name: item.name, duration: minutes(item.duration_minutes), recipient: item.recipient || '' }))
  const first = snapshot.lines?.[0]?.label || 'Treatment'
  return [{ name: first.replace(/, \d+ minutes$/, ''), duration: minutes(snapshot.appointment.duration_minutes), recipient: '' }]
}

// A gift voucher's receipt (GV-…, 20261221100000): who bought it, who it is for, and what it pays for. Never the whole code.
function giftVoucherView(receipt) {
  const s = receipt.snapshot
  const b = s.business || {}
  const status = receipt.standing?.status || 'paid'
  const refunded = status === 'refunded'
  const stamp = status === 'paid' ? 'PAID' : refunded ? 'REFUNDED' : 'VOID'
  const notice = status === 'paid' ? null
    : refunded ? `This gift voucher was refunded${receipt.standing.refunded_at ? ` on ${longDay(receipt.standing.refunded_at)}` : ''}${receipt.standing.refunded_gbp != null ? ` (${money(receipt.standing.refunded_gbp)})` : ''}. Its code no longer works. This receipt is kept as a record.`
      : status === 'refund_due' ? 'This gift voucher was cancelled and its money is being sent back. Its code no longer works.'
        : 'This gift voucher was cancelled after the receipt was issued. It is kept as a record and is no longer proof of payment.'
  const v = s.voucher || {}
  return {
    kind: 'gift_voucher',
    title: 'Gift Voucher Receipt',
    number: receipt.number || s.number,
    issuedOn: calendarDay(s.issued_on),
    status, stamp, notice,
    business: { name: b.name || '', tagline: b.tagline || '', contact: [b.phone, b.email, b.website].filter(Boolean).join('  ·  '), address: b.address || '', website: b.website || '' },
    client: s.billed_to,
    reference: s.reference,
    referenceLabel: 'Reference',
    leftHeading: 'BOUGHT BY',
    leftRows: [['Name', s.billed_to], ...(s.buyer_email ? [['Email', s.buyer_email]] : [])],
    rightHeading: 'GIFT VOUCHER',
    rightRows: [['For', v.for || ''], ...(v.from ? [['From', v.from]] : []), ['Gift', v.gift ? v.gift[0].toUpperCase() + v.gift.slice(1) : ''],
      ['Code', `ending ${v.code_end || ''}`], ...(v.expires_at ? [['Use by', longDay(v.expires_at)]] : [])],
    treatments: [],
    showRecipients: false,
    lines: s.lines.map(line => ({ label: line.label, amount: money(line.amount) })),
    total: money(s.total),
    paid: money(s.payment?.amount ?? s.total),
    gift: null,
    method: methodLabel(s.payment?.method),
    paidOn: s.payment?.paid_at ? longDay(s.payment.paid_at) : '',
    credentials: b.practitioner_name ? { name: b.practitioner_name, title: b.practitioner_title || '', association: b.association || '', number: b.membership_number || '' } : null,
    note: '',
    closing: b.closing || '',
    footnote: 'Not a VAT invoice. This receipt is for buying a gift voucher, not for a treatment: the person who uses it gets their own treatment receipt after their session.',
    fileName: `Gift voucher receipt ${receipt.number || s.number}.pdf`,
  }
}

export function receiptView(receipt) {
  if (receipt.snapshot?.kind === 'gift_voucher') return giftVoucherView(receipt)
  const s = receipt.snapshot
  const b = s.business || {}
  const standing = standingWords(receipt.standing)
  const treatments = treatmentsOf(s)
  const credentials = b.practitioner_name ? {
    name: b.practitioner_name, title: b.practitioner_title || '', association: b.association || '', number: b.membership_number || '',
  } : null
  const gift = s.gift ? { covered: money(s.gift.covered), ending: s.gift.code_end || '', yours: money(s.payment?.amount ?? 0) } : null
  return {
    kind: 'treatment',
    title: 'Payment Receipt',
    referenceLabel: 'Booking ref',
    footnote: 'Not a VAT invoice. Whether this treatment can be reimbursed depends on your insurer and your policy.',
    gift,
    number: receipt.number || s.number,
    issuedOn: calendarDay(s.issued_on),
    ...standing,
    business: {
      name: b.name || '',
      tagline: b.tagline || '',
      contact: [b.phone, b.email, b.website].filter(Boolean).join('  ·  '),
      address: b.address || '',
      website: b.website || '',
    },
    client: s.billed_to,
    reference: s.reference,
    treatmentDate: calendarDay(s.appointment.date),
    duration: minutes(s.appointment.duration_minutes),
    treatments,
    // Two or more people on one booking: each treatment is listed with who it was for, so each person can claim their own.
    showRecipients: treatments.length > 1 && treatments.some(item => item.recipient),
    lines: s.lines.map(line => ({ label: line.label, amount: money(line.amount) })),
    total: money(s.total),
    paid: money(s.payment?.amount ?? s.total),
    method: gift && Number(s.payment?.amount ?? 0) === 0 ? 'Gift voucher' : methodLabel(s.payment?.method),
    paidOn: s.payment?.paid_at ? longDay(s.payment.paid_at) : '',
    credentials,
    note: s.note || '',
    closing: b.closing || '',
    fileName: `Receipt ${receipt.number || s.number}.pdf`,
  }
}
