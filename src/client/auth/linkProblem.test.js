import { describe, expect, it } from 'vitest'
import { linkProblem, withoutLinkProblem } from './linkProblem.js'

const EXPIRED = '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb='

describe('what an email link that did not work says', () => {
  it('says nothing for an ordinary address', () => {
    expect(linkProblem('', '')).toBe('')
    expect(linkProblem('', '?step=0')).toBe('')
    expect(linkProblem('#key=95cd59ee615d4663950a486b25e8c576', '?booking=c972f7b3')).toBe('')
    expect(linkProblem('#access_token=abc&type=signup', '')).toBe('')
  })
  it('says a link that was used or has run out can no longer be used, and what to do', () => {
    const said = linkProblem(EXPIRED, '?step=0')
    expect(said).toMatch(/already been used or has expired/)
    expect(said).toMatch(/sign in now/)
    expect(said).toMatch(/ask for a new link/)
  })
  it('reads the reason from the query part as well as from the part after the #', () => {
    expect(linkProblem('', '?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')).toMatch(/already been used or has expired/)
  })
  it('gives a plain sentence for any other problem with a link, never the service\'s own words', () => {
    const said = linkProblem('#error=server_error&error_code=unexpected_failure&error_description=Database+error+saving+new+user', '')
    expect(said).toBe('That email link could not be used. Please sign in, or contact Vad if it keeps happening.')
    expect(said).not.toMatch(/database/i)
  })
})

describe('the address once that has been said', () => {
  it('drops the reason and keeps everything else', () => {
    expect(withoutLinkProblem(`https://booking.vadmassage.com/?step=0${EXPIRED}`)).toBe('/?step=0')
    expect(withoutLinkProblem('https://booking.vadmassage.com/account?booking=b1&error=access_denied&error_code=otp_expired')).toBe('/account?booking=b1')
  })
  it('leaves the private code of a booking link alone', () => {
    expect(withoutLinkProblem('https://booking.vadmassage.com/account?booking=b1#key=95cd59ee615d4663950a486b25e8c576')).toBe('/account?booking=b1#key=95cd59ee615d4663950a486b25e8c576')
  })
})
