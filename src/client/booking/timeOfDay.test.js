import { describe, expect, it } from 'vitest'
import { groupSlots } from './timeOfDay.js'

describe('groupSlots', () => {
  it('splits the day into morning, afternoon and evening, in time order', () => {
    expect(groupSlots([1080, 600, 720, 990, 690, 1020])).toEqual([
      { key: 'morning', label: 'Morning', slots: [600, 690] },
      { key: 'afternoon', label: 'Afternoon', slots: [720, 990] },
      { key: 'evening', label: 'Evening', slots: [1020, 1080] },
    ])
  })
  it('leaves out the parts of the day with nothing free', () => {
    expect(groupSlots([780, 840]).map(group => group.key)).toEqual(['afternoon'])
    expect(groupSlots([])).toEqual([])
  })
  it('puts the boundaries in the later group: noon is afternoon, five o clock is evening', () => {
    expect(groupSlots([719, 720, 1019, 1020]).map(group => [group.key, group.slots])).toEqual([['morning', [719]], ['afternoon', [720, 1019]], ['evening', [1020]]])
  })
})
