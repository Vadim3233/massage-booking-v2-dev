// What the Delete section of a client's page says, written from what the database reports (admin_client_delete_check).
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const joined = parts => parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`

// Everything that would be removed, in plain words. A login is only mentioned when there is a real one.
export function whatWouldGo(check) {
  const parts = ['their details']
  if (check.addresses > 0) parts.push(plural(check.addresses, 'saved address', 'saved addresses'))
  if (check.notes > 0) parts.push(plural(check.notes, 'note'))
  if (check.waitlist > 0) parts.push(plural(check.waitlist, 'waiting-list request'))
  if (check.login === 'registered') parts.push('their online account')
  const text = joined(parts)
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export const deleteQuestion = (name, check) => `Delete ${name}? ${whatWouldGo(check)} will be removed for good. This can't be undone.`

// What the question said would go, handed back with the deletion. The database refuses (and she is asked again) if any of it changed
// between the question and the press, so nothing is deleted that she was not told about.
export const deleteScope = check => ({ addresses: check.addresses, notes: check.notes, waitlist: check.waitlist, login: check.login })

// Why a client cannot be deleted. Bookings are the common reason, and the way out is to switch off online booking.
export function whyNotDelete(name, check) {
  switch (check.reason) {
    case 'bookings':
      return `${name} has ${plural(check.bookings, 'booking')}, so they can't be deleted. Bookings, payments and receipts are your records, so they stay. To stop them booking online, switch off online booking above.`
    case 'repeats':
      return `${name} has a repeating booking, so they can't be deleted.`
    case 'booking_now':
      return "Someone is in the middle of booking right now, so nobody can be deleted for a few minutes. Try again soon."
    case 'admin':
      return `${name} is signed in as an Admin, so they can't be deleted here.`
    default:
      return `${name} can't be deleted right now.`
  }
}

export const deletedMessage = name => `${name} was deleted.`
