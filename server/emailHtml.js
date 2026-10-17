// The HTML version of an email to a client: the same words as the plain-text version, set in the look of the booking pages. The plain text is
// still sent with it (an email carries both and the reader's mail app shows one), so nothing is lost where HTML is not shown.
//
// Mail apps cannot read the site's stylesheet, so the colours are written out here. They are the site's own (src/index.css), and
// server/emailHtml.test.js fails if one of them drifts from its token or stops being readable. No pictures, no web fonts and no scripts: a mail
// app blocks pictures until asked, and the wordmark is just text in the serif the site falls back to.
export const EMAIL_COLOURS = {
  page: '#faf8f5', // --paper: the ivory behind the card
  card: '#ffffff', // --surface
  hairline: '#e6e3df', // --hairline
  ink: '#142f46', // --ink: midnight navy, the words that matter
  inkSoft: '#435467', // --ink-soft
  muted: '#636d78', // --muted
  primary: '#345b73', // --primary: slate blue, the button and the one emphasised word
  onPrimary: '#ffffff', // --on-primary
}
export const EMAIL_TAGLINE = 'Personal treatments, thoughtfully arranged.'
export const BUTTON_LABEL = 'See or change your booking'

const C = EMAIL_COLOURS
const SERIF = "Georgia, 'Times New Roman', serif"
const SANS = "Arial, Helvetica, sans-serif"
// The day and time as the database words them ("Mon 19 Oct at 15:00"), set in bold so it stands out of the sentence.
const WHEN = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) at \d{2}:\d{2}\b/g

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

// Only a web address can go behind the button: never anything else a link could be made to run.
const safeUrl = (url) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(url || '')) ? String(url) : '')

// The title, with its last word in italics and slate blue as the booking pages do ("Your appointment is confirmed"). A title that does not end in
// a word (a receipt's number, in brackets) is set plain.
function heading(title) {
  const words = String(title || '').trim().split(/\s+/).filter(Boolean)
  const last = words.pop() || ''
  if (!/^\p{L}+$/u.test(last)) return escapeHtml(String(title || '').trim())
  const lead = words.length ? `${escapeHtml(words.join(' '))} ` : ''
  return `${lead}<em style="font-style:italic;color:${C.primary}">${escapeHtml(last)}</em>`
}

const paragraph = (lines, style) => `<p style="margin:0 0 16px;${style}">${lines.map((line) => escapeHtml(line).replace(WHEN, (when) => `<strong>${when}</strong>`)).join('<br>')}</p>`

function button(url) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 24px"><tr><td bgcolor="${C.primary}" style="background:${C.primary};border-radius:999px">`
    + `<a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 28px;font:600 16px/1.2 ${SANS};color:${C.onPrimary};text-decoration:none;border-radius:999px">${BUTTON_LABEL}</a></td></tr></table>`
}

// The line that holds the link ("See or change your booking: {link}"). A "{link}" typed into the middle of anything else is just text.
const isLinkLine = (line) => /:\s*\{link\}\s*$/.test(line)

// The body is the plain text with a "{link}" where the booking's private link goes: blocks are split at blank lines, lines inside a block are kept
// as lines, a "Reference:" line is set small and quiet, and the line that holds the link becomes the button (or nothing, when there is no link).
function blocks(body, url) {
  const out = []
  for (const block of String(body || '').replace(/\r\n?/g, '\n').trim().split(/\n{2,}/)) {
    const lines = block.split('\n')
    const hasLink = lines.some(isLinkLine)
    let run = []
    const flush = () => { if (run.length) out.push(paragraph(run, `font-size:16px;line-height:1.6;color:${C.ink}`)); run = [] }
    for (const line of lines.filter((text) => !isLinkLine(text))) {
      if (/^Reference:/.test(line)) { flush(); out.push(paragraph([line], `font-size:14px;line-height:1.5;color:${C.inkSoft}`)) } else run.push(line)
    }
    flush()
    if (hasLink && url) out.push(button(url))
  }
  return out.join('')
}

const preheader = (body) => String(body || '').split('\n').map((line) => line.trim()).find((line) => line && !isLinkLine(line) && !/^Reference:/.test(line))?.slice(0, 110) || ''

// `body` is the message as the database wrote it (with its "{link}"), `url` the private link to put on the button (empty when there is none),
// `canReply` whether a reply reaches Vad (a Reply-To is set), so the footer only invites one when it will be read. The card is 560px wide where a
// mail app understands only the width attribute (Outlook on a computer), and shrinks to the screen where it understands the style (phones, Gmail).
export function composeEmailHtml({ title, body, url, canReply }) {
  const link = safeUrl(url)
  const spam = 'If it landed in your spam folder, please press “Not spam” so my messages reach you.'
  const cell = (padding, style, inner) => `<tr><td style="padding:${padding};${style}">${inner}</td></tr>`
  const text = `font-family:${SANS};font-size:16px;line-height:1.6;color:${C.ink}`
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader(body))}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${C.page}" style="background:${C.page}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" bgcolor="${C.card}" style="width:100%;max-width:560px;background:${C.card};border:1px solid ${C.hairline};border-radius:16px">
${cell('28px 28px 0', `font-family:${SERIF};font-size:20px;letter-spacing:.3px;color:${C.ink}`, 'VadMassage')}
${cell('10px 28px 0', '', `<h1 style="margin:0;font:500 28px/1.22 ${SERIF};color:${C.ink}">${heading(title)}</h1>`)}
${cell('18px 28px 8px', text, blocks(body, link))}
${cell('16px 28px 24px', `border-top:1px solid ${C.hairline};font-family:${SANS};font-size:13px;line-height:1.55;color:${C.muted}`,
    `${canReply ? 'Just reply to this email if you have any questions. ' : ''}${spam}<br>VadMassage · ${EMAIL_TAGLINE}`)}
</table>
</td></tr></table>
</body>
</html>
`
}
