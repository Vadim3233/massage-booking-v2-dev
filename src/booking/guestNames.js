// A booking for several people never asks for names: they are simply Guest 1, Guest 2 and so on,
// unless someone has typed a name. A booking for one person is for the person who is booking.
export const guestLabel = index => `Guest ${index + 1}`

export function sessionNames(sessions, bookerName = '') {
  const several = sessions.length > 1
  return sessions.map((session, index) => {
    const typed = String(session.recipient_name || '').trim()
    return typed || (several ? guestLabel(index) : String(bookerName || '').trim())
  })
}

export function withGuestNames(sessions, bookerName = '') {
  const names = sessionNames(sessions, bookerName)
  return sessions.map((session, index) => ({ ...session, recipient_name: names[index] }))
}
