// A Wise payment link as typed or pasted (with or without https:// and www.), tidied, or '' when it is not one.
// The database checks the same, so a slip can never send clients to another site.
export function wiseLinkOf(text) {
  let link = String(text || '').trim()
  if (!link) return ''
  if (!/^https:\/\//i.test(link)) link = `https://${link.replace(/^http:\/\//i, '')}`
  link = link.replace(/^https:\/\/(www\.)?wise\.com\//i, 'https://wise.com/')
  return /^https:\/\/wise\.com\/pay\/[A-Za-z0-9/_.?=&%-]{1,180}$/.test(link) ? link : ''
}
