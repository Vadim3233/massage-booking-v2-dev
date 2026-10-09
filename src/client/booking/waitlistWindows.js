// The times of day a client can ask for when joining the waitlist, as start and end minutes.
export const TIME_WINDOWS = [
  ['any', 'Any time of day', 0, 1440],
  ['morning', 'Morning (before 12:00)', 0, 720],
  ['afternoon', 'Afternoon (12:00 to 17:00)', 720, 1020],
  ['evening', 'Evening (after 17:00)', 1020, 1440],
]
