// A Wise payment link as typed or pasted (with or without https:// and www.), tidied, or '' when it is not one.
// The database checks the same, so a slip can never send clients to another site.
export function wiseLinkOf(text) {
  let link = String(text || '').trim()
  if (!link) return ''
  if (!/^https:\/\//i.test(link)) link = `https://${link.replace(/^http:\/\//i, '')}`
  link = link.replace(/^https:\/\/(www\.)?wise\.com\//i, 'https://wise.com/')
  return /^https:\/\/wise\.com\/pay\/[A-Za-z0-9/_.?=&%-]{1,180}$/.test(link) ? link : ''
}

// The Wise line for a message that gives the bank details (a WhatsApp reminder, an email or a Telegram message): the link, and a reminder to add
// the reference, which the link cannot carry. Nothing when no link is saved.
export const WISE_REFERENCE_NOTE = '(please add the reference above)'
export function wiseLines(link) {
  const tidy = wiseLinkOf(link)
  return tidy ? [`Have Wise? Pay here: ${tidy}`, WISE_REFERENCE_NOTE] : []
}

// A message as the database wrote it, with the Wise line added as its own paragraph straight after the bank details (the paragraph with
// "Account number:"), so the reference written above it is the one to use. A message without bank details, or that has the line already, is unchanged.
export function withWiseLine(body, link) {
  const lines = wiseLines(link)
  const text = String(body ?? '')
  if (!lines.length || !/^Account number:/m.test(text) || text.includes('Have Wise?')) return body
  const blocks = text.split(/\n{2,}/)
  const at = blocks.findIndex(block => /^Account number:/m.test(block))
  blocks.splice(at + 1, 0, lines.join('\n'))
  return blocks.join('\n\n')
}
