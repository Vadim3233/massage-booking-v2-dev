import { dateLabel } from './calendarPresentation.js'

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const joinWords = parts => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`)

// How a profile is signed in, in the words the Admin uses.
export const kindLabel = kind => ({ registered: 'Has a login', guest: 'Booked as a guest', added: 'Added by you' }[kind] || 'Client')

// How the two profiles of a pair are signed in, for the line under it.
const KIND_ORDER = ['registered', 'added', 'guest']
export function kindsText(first, second) {
  if (first === second) return { guest: 'both booked as guests', added: 'both added by you', registered: 'both have a login' }[first] || 'both clients'
  const [one, two] = [first, second].sort((x, y) => KIND_ORDER.indexOf(x) - KIND_ORDER.indexOf(y))
  return `${kindLabel(one).toLowerCase()} and ${kindLabel(two).toLowerCase()}`
}

// What two profiles have in common.
export function matchedText(matched) {
  const has = new Set(matched || [])
  if (has.has('email') && has.has('phone')) return 'email and phone number'
  return has.has('phone') ? 'phone number' : 'email'
}

// What a profile holds, as short lines for its card: the bookings (and the days of the latest), then anything else.
export function holdings(profile) {
  const days = (profile.dates || []).map(date => dateLabel(date))
  const more = [
    profile.notes ? plural(profile.notes, 'note') : '',
    profile.addresses ? plural(profile.addresses, 'address', 'addresses') : '',
    profile.repeats ? plural(profile.repeats, 'weekly repeat') : '',
  ].filter(Boolean)
  return {
    bookings: profile.bookings ? plural(profile.bookings, 'booking') : 'No bookings yet',
    days: days.join(', '),
    more: more.join(' · '),
  }
}

// What the combine moved, said back to the Admin.
export function movesText(summary) {
  const parts = [
    summary?.bookings ? plural(summary.bookings, 'booking') : '',
    summary?.repeats ? plural(summary.repeats, 'weekly repeat') : '',
    summary?.notes ? plural(summary.notes, 'note') : '',
    summary?.addresses ? plural(summary.addresses, 'address', 'addresses') : '',
    summary?.waitlist ? plural(summary.waitlist, 'waitlist request') : '',
  ].filter(Boolean)
  return parts.length ? `Moved ${joinWords(parts)}.` : 'Nothing needed moving.'
}

// Two profiles can be told apart by name and by how they are signed in.
export const profileLabel = (name, kind) => `${name} (${kindLabel(kind).toLowerCase()})`

// What combining changes about who can see what, said before it is done. A guest's profile can be reached from the phone or browser
// that made it, so a guest whose profile goes loses sight of those bookings (unless they sign in), and a guest whose profile stays
// gains sight of the other profile's bookings and addresses.
export function combineNotices(keep, leave) {
  const name = profile => [profile.first_name, profile.last_name].filter(Boolean).join(' ') || 'Client'
  const notices = []
  if (leave.kind === 'guest' && leave.bookings > 0) {
    notices.push(keep.kind === 'registered' ? `${name(leave)} will then see and change these bookings only by signing in.` : `${name(leave)}'s own phone or browser will then stop showing these bookings.`)
  }
  if (keep.kind === 'guest' && (leave.bookings > 0 || leave.addresses > 0)) notices.push(`${name(keep)}'s own phone or browser will then be able to see these bookings and addresses.`)
  return notices
}

// Where a mistake is easier to make, the screen says so before anyone combines: different first names, or only a phone number in
// common (a phone number typed when booking is never checked, so it proves less than an email that has been confirmed).
export function cautions(profiles, matched) {
  const first = profile => (profile.first_name || '').trim().toLowerCase()
  const notes = []
  if (first(profiles[0]) !== first(profiles[1])) notes.push('The first names are different, so check that these really are the same person.')
  if (matched?.length === 1 && matched[0] === 'phone') notes.push('They share a phone number but not an email. A phone number typed when booking is not checked, so make sure this is the same person before you combine them.')
  return notes
}
