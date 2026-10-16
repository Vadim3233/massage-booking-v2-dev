import { useEffect, useState } from 'react'

// An email link that was already used, or has run out, brings the person back to the site with the reason in the address (after a # or a ?):
// error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired. The page used to open as if nothing had
// happened, so this says it in words.
const PARAMS = ['error', 'error_code', 'error_description']
const keys = (text) => new URLSearchParams(String(text).replace(/^[#?]/, ''))

export function linkProblem(hash = '', search = '') {
  const found = [keys(hash), keys(search)].find((params) => params.has('error') || params.has('error_code'))
  if (!found) return ''
  const reason = `${found.get('error_code') || ''} ${found.get('error_description') || ''}`
  if (/otp_expired|expired|invalid/i.test(reason)) {
    return 'That email link has already been used or has expired. If you were confirming your email, you can sign in now. If you were resetting your password, ask for a new link from the Sign in page.'
  }
  return 'That email link could not be used. Please sign in, or contact Vad if it keeps happening.'
}

// The same address without the reason in it, so a reload does not say it again. Anything else in the address (the private code of a booking link,
// the step of a booking) is left as it was.
export function withoutLinkProblem(href) {
  const url = new URL(href)
  const hash = keys(url.hash)
  if (PARAMS.some((name) => hash.has(name))) url.hash = ''
  for (const name of PARAMS) url.searchParams.delete(name)
  return `${url.pathname}${url.search}${url.hash}`
}

// What to say about the link this page was opened with, once, and the address tidied.
export function useLinkProblem() {
  const [message] = useState(() => linkProblem(window.location.hash, window.location.search))
  useEffect(() => {
    if (!message) return
    const tidy = withoutLinkProblem(window.location.href)
    if (tidy !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(null, '', tidy)
  }, [message])
  return message
}
