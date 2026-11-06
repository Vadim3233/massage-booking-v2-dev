// "None of these suit me" (ADR-095): what a client can say would have suited them instead. Weekdays and weekends differ, so a Saturday never
// offers "Weekend instead". The keys are what the Visitors page reads back.
export const PREFERENCE_LABELS = {
  early: 'Early morning', lunch: 'Lunchtime', after_work: 'After work', weekend: 'Weekend instead',
  morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', weekday: 'A weekday instead',
}

export function preferenceChoices(date) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay()
  const keys = weekday === 0 || weekday === 6 ? ['morning', 'afternoon', 'evening', 'weekday'] : ['early', 'lunch', 'after_work', 'weekend']
  return keys.map(key => [key, PREFERENCE_LABELS[key]])
}
