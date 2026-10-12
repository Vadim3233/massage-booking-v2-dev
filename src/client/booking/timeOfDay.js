// Times of day read more easily in three short rows than in one long grid.
export const SLOT_GROUPS = [
  { key: 'morning', label: 'Morning', from: 0, until: 12 * 60 },
  { key: 'afternoon', label: 'Afternoon', from: 12 * 60, until: 17 * 60 },
  { key: 'evening', label: 'Evening', from: 17 * 60, until: 24 * 60 },
]

export function groupSlots(starts) {
  const sorted = [...starts].sort((a, b) => a - b)
  return SLOT_GROUPS
    .map(group => ({ key: group.key, label: group.label, slots: sorted.filter(start => start >= group.from && start < group.until) }))
    .filter(group => group.slots.length)
}
