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

export function receiptView(receipt) {
  const s = receipt.snapshot
  const b = s.business || {}
  const standing = standingWords(receipt.standing)
  const treatments = treatmentsOf(s)
  const credentials = b.practitioner_name ? {
    name: b.practitioner_name, title: b.practitioner_title || '', association: b.association || '', number: b.membership_number || '',
  } : null
  return {
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
    method: methodLabel(s.payment?.method),
    paidOn: s.payment?.paid_at ? longDay(s.payment.paid_at) : '',
    credentials,
    note: s.note || '',
    closing: b.closing || '',
    fileName: `Receipt ${receipt.number || s.number}.pdf`,
  }
}
