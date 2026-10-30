import { receiptView } from './receiptView.js'

// The receipt as an A4 PDF: what a client keeps, prints, or sends to their health insurer. The page is drawn here from receiptView,
// in the colours of the app, and stays readable when printed in black and white (the dark band prints as dark grey with white words).

const A4 = [595.28, 841.89]
const MARGIN = 56
const hex = value => [1, 3, 5].map(at => parseInt(value.slice(at, at + 2), 16) / 255)
const COLOURS = { navy: '#193B57', powder: '#EAF3F8', offwhite: '#FAFAF8', gold: '#C9A86A', ink: '#253341', muted: '#5B6875', rule: '#D9E1E8' }
export const FONT_FILES = { body: '/fonts/Inter-Regular.ttf', strong: '/fonts/Inter-SemiBold.ttf', display: '/fonts/PlayfairDisplay-SemiBold.ttf' }

// Splits text into lines no wider than `width`, breaking at spaces (and inside a word only when one word is wider than the line).
export function wrapText(text, font, size, width) {
  const lines = []
  for (const paragraph of String(text).split('\n')) {
    let line = ''
    for (const word of paragraph.split(/ +/)) {
      const tryLine = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(tryLine, size) <= width) { line = tryLine; continue }
      if (line) lines.push(line)
      line = word
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length - 1
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut -= 1
        lines.push(line.slice(0, cut))
        line = line.slice(cut)
      }
    }
    lines.push(line)
  }
  return lines
}

// `lib` is pdf-lib ({ PDFDocument, rgb }), `fontkit` its font reader, `fonts` the three font files as bytes.
export async function buildReceiptPdf(view, { lib, fontkit, fonts }) {
  const { PDFDocument, rgb } = lib
  const colour = name => rgb(...hex(COLOURS[name]))
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  doc.setTitle(`Payment receipt ${view.number}`)
  doc.setAuthor(view.business.name)
  doc.setSubject(`Payment receipt for ${view.client}`)
  doc.setCreator(view.business.name)
  const body = await doc.embedFont(fonts.body)
  const strong = await doc.embedFont(fonts.strong)
  const display = await doc.embedFont(fonts.display)
  const page = doc.addPage(A4)
  const [width, height] = A4
  const inner = width - MARGIN * 2
  const right = width - MARGIN

  const text = (value, x, y, { font = body, size = 10, color = 'ink', align = 'left' } = {}) => {
    const words = String(value)
    const at = align === 'right' ? x - font.widthOfTextAtSize(words, size) : x
    page.drawText(words, { x: at, y, size, font, color: colour(color) })
  }
  const paragraph = (value, x, y, w, { font = body, size = 10, color = 'ink', leading = 1.45 } = {}) => {
    const lines = wrapText(value, font, size, w)
    lines.forEach((line, index) => text(line, x, y - index * size * leading, { font, size, color }))
    return y - lines.length * size * leading
  }
  const rule = (y, { color = 'rule', thickness = 0.75, from = MARGIN, to = right } = {}) =>
    page.drawLine({ start: { x: from, y }, end: { x: to, y }, thickness, color: colour(color) })
  const heading = (value, y) => {
    text(value.toUpperCase(), MARGIN, y, { font: strong, size: 8, color: 'navy' })
    rule(y - 7, { color: 'gold', thickness: 0.9 })
    return y - 24
  }

  // The band: the business name, and how to find it.
  const bandHeight = 112
  page.drawRectangle({ x: 0, y: height - bandHeight, width, height: bandHeight, color: colour('navy') })
  page.drawRectangle({ x: 0, y: height - bandHeight - 3, width, height: 3, color: colour('gold') })
  const nameLines = wrapText(view.business.name, display, 19, inner * 0.58)
  let y = height - 46
  nameLines.forEach(line => { text(line, MARGIN, y, { font: display, size: 19, color: 'offwhite' }); y -= 23 })
  if (view.business.tagline) paragraph(view.business.tagline, MARGIN, y - 2, inner * 0.58, { size: 8.5, color: 'offwhite' })
  const aside = [view.business.contact, view.business.address].filter(Boolean).join('\n')
  wrapText(aside, body, 8.5, inner * 0.38).forEach((line, index) => text(line, right, height - 46 - index * 12.5, { size: 8.5, color: 'offwhite', align: 'right' }))

  // The title, the number and the date, and whether it is paid.
  y = height - bandHeight - 52
  text('Payment Receipt', MARGIN, y, { font: display, size: 25, color: 'navy' })
  const stampSize = 12
  const stampWidth = strong.widthOfTextAtSize(view.stamp, stampSize) + view.stamp.length * 2.4 + 22
  page.drawRectangle({ x: right - stampWidth, y: y - 6, width: stampWidth, height: 28, borderColor: colour('navy'), borderWidth: 1.6 })
  let stampX = right - stampWidth + 11
  for (const letter of view.stamp) { text(letter, stampX, y + 3, { font: strong, size: stampSize, color: 'navy' }); stampX += strong.widthOfTextAtSize(letter, stampSize) + 2.4 }
  y -= 22
  const meta = [['Receipt No', view.number], ['Issued', view.issuedOn], ['Booking ref', view.reference]]
  let metaX = MARGIN
  for (const [label, value] of meta) {
    text(label, metaX, y, { size: 9, color: 'muted' })
    metaX += body.widthOfTextAtSize(label, 9) + 5
    text(value, metaX, y, { font: strong, size: 9 })
    metaX += strong.widthOfTextAtSize(value, 9) + 18
  }
  y -= 16
  if (view.notice) {
    const lines = wrapText(view.notice, strong, 9, inner - 24)
    const boxHeight = lines.length * 13 + 16
    page.drawRectangle({ x: MARGIN, y: y - boxHeight + 6, width: inner, height: boxHeight, borderColor: colour('navy'), borderWidth: 1 })
    lines.forEach((line, index) => text(line, MARGIN + 12, y - 9 - index * 13, { font: strong, size: 9, color: 'navy' }))
    y -= boxHeight + 4
  }

  // Who it is for, and the treatment.
  y -= 22
  const columnWidth = (inner - 36) / 2
  const pairs = (rows, x, startY, labelWidth) => {
    let rowY = startY
    for (const [label, value] of rows) {
      text(label, x, rowY, { size: 9.5, color: 'muted' })
      rowY = paragraph(value, x + labelWidth, rowY, columnWidth - labelWidth, { font: strong, size: 9.5 }) - 3
    }
    return rowY
  }
  text('CLIENT', MARGIN, y, { font: strong, size: 8, color: 'navy' })
  rule(y - 7, { color: 'gold', thickness: 0.9, to: MARGIN + columnWidth })
  const second = MARGIN + columnWidth + 36
  text('TREATMENT', second, y, { font: strong, size: 8, color: 'navy' })
  rule(y - 7, { color: 'gold', thickness: 0.9, from: second })
  const clientEnd = pairs([['Name', view.client]], MARGIN, y - 24, 62)
  const single = view.treatments.length === 1 ? view.treatments[0] : null
  const treatmentRows = single
    ? [['Treatment', single.name], ['Date', view.treatmentDate], ['Duration', single.duration]]
    : [['Date', view.treatmentDate], ['Duration', view.duration]]
  const treatmentEnd = pairs(treatmentRows, second, y - 24, 62)
  y = Math.min(clientEnd, treatmentEnd) - 10

  if (!single) {
    // Several treatments on one booking: one row each, with who it was for when the booking names them.
    y -= 6
    for (const item of view.treatments) {
      const words = view.showRecipients && item.recipient ? `${item.name}, for ${item.recipient}` : item.name
      text(words, MARGIN, y, { size: 9.5 })
      text(item.duration, right, y, { size: 9.5, align: 'right' })
      rule(y - 7)
      y -= 20
    }
    y -= 4
  }

  // What was paid.
  y -= 14
  y = heading('Payment summary', y)
  text('Description', MARGIN, y, { size: 8.5, color: 'muted' })
  text('Amount', right, y, { size: 8.5, color: 'muted', align: 'right' })
  y -= 8
  for (const line of view.lines) {
    rule(y)
    y -= 16
    const after = paragraph(line.label, MARGIN, y, inner - 110, { size: 10 })
    text(line.amount, right, y, { size: 10, align: 'right' })
    y = after + 6
  }
  rule(y, { color: 'navy', thickness: 1.3 })
  y -= 19
  text(view.status === 'paid' ? 'TOTAL PAID' : 'TOTAL', MARGIN, y, { font: strong, size: 11.5, color: 'navy' })
  text(view.paid, right, y, { font: strong, size: 11.5, color: 'navy', align: 'right' })
  y -= 24
  const payment = [['Payment method', view.method], ...(view.paidOn ? [['Paid on', view.paidOn]] : []), ['Payment status', view.stamp === 'PAID' ? 'Paid' : view.stamp[0] + view.stamp.slice(1).toLowerCase()]]
  let payX = MARGIN
  for (const [label, value] of payment) {
    text(label, payX, y, { size: 9, color: 'muted' })
    payX += body.widthOfTextAtSize(label, 9) + 6
    text(value, payX, y, { font: strong, size: 9 })
    payX += strong.widthOfTextAtSize(value, 9) + 22
  }
  y -= 14

  // The practitioner and their professional register: on every receipt, as insurers ask for them.
  if (view.credentials) {
    y -= 20
    y = heading('Practitioner credentials', y)
    const c = view.credentials
    const rows = [
      [c.name, display, 14, 'navy'],
      ...(c.title ? [[c.title, body, 10, 'ink']] : []),
      ...(c.association ? [[`Professional association: ${c.association}`, body, 10, 'ink']] : []),
      ...(c.number ? [[`Membership / registration number: ${c.number}`, strong, 10, 'ink']] : []),
    ]
    const boxHeight = rows.reduce((sum, [, , size]) => sum + size * 1.55, 0) + 22
    page.drawRectangle({ x: MARGIN, y: y - boxHeight + 12, width: inner, height: boxHeight, color: colour('powder') })
    page.drawRectangle({ x: MARGIN, y: y - boxHeight + 12, width: 3, height: boxHeight, color: colour('gold') })
    let rowY = y - 6
    for (const [value, font, size, color] of rows) { rowY = paragraph(value, MARGIN + 18, rowY, inner - 36, { font, size, color }) - size * 0.1 }
    y -= boxHeight + 6
  }

  if (view.note) { y -= 10; y = paragraph(view.note, MARGIN, y, inner, { size: 9.5 }) }

  // The foot of the page.
  const foot = 70
  rule(foot + 26)
  paragraph('Not a VAT invoice. Whether this treatment can be reimbursed depends on your insurer and your policy.', MARGIN, foot + 40, inner, { size: 7.5, color: 'muted' })
  text(view.business.name, MARGIN, foot + 8, { font: strong, size: 9 })
  if (view.business.website) text(view.business.website, MARGIN, foot - 5, { size: 9, color: 'muted' })
  text(view.closing || `Thank you for choosing ${view.business.name}.`, right, foot + 2, { font: display, size: 10.5, color: 'navy', align: 'right' })

  return doc.save()
}

// Makes the PDF in the browser and hands it to the person as a file. pdf-lib and the fonts are only fetched when a receipt is downloaded.
export async function downloadReceiptPdf(receipt) {
  const view = receiptView(receipt)
  const [lib, fontkitModule, ...files] = await Promise.all([
    import('pdf-lib'), import('@pdf-lib/fontkit'),
    ...Object.values(FONT_FILES).map(async path => {
      const response = await fetch(path)
      if (!response.ok) throw new Error('font')
      return response.arrayBuffer()
    }),
  ])
  const [bodyFont, strongFont, displayFont] = files
  const bytes = await buildReceiptPdf(view, { lib, fontkit: fontkitModule.default || fontkitModule, fonts: { body: bodyFont, strong: strongFont, display: displayFont } })
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  const link = document.createElement('a')
  link.href = url
  link.download = view.fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return view.fileName
}
