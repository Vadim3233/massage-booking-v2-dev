import { supabase } from '../lib/supabase.js'

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

// Whole and half hours from midnight, as the scheduling engine works in 30-minute steps.
export const timeOptions = (includeMidnightEnd = false) => {
  const options = []
  for (let minutes = 0; minutes <= (includeMidnightEnd ? 1440 : 1410); minutes += 30) options.push(minutes)
  return options
}
export const clock = minutes => minutes === 1440 ? '24:00' : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

// The same rules the database enforces, so mistakes are caught before saving with a plain sentence.
export function validateHours(entry) {
  if (!entry.available) return ''
  if (entry.start_minutes == null || entry.end_minutes == null) return 'Choose a start and an end time.'
  if (entry.start_minutes >= entry.end_minutes) return 'The end time must be after the start time.'
  if (entry.start_mode === 'fixed') {
    if (entry.fixed_start_minutes == null) return 'Choose the time of the first appointment.'
    if (entry.fixed_start_minutes < entry.start_minutes || entry.fixed_start_minutes >= entry.end_minutes) return 'The first appointment must be inside your working hours.'
  }
  return ''
}
// A block runs from a date and time to a later date and time, like an event in a phone calendar.
export function validateBlock(block) {
  if (!block.start_date) return 'Choose a date.'
  if (!block.end_date) return 'Choose an end date.'
  if (block.kind === 'personal_event' && !block.title.trim()) return 'Give the personal event a name.'
  if (block.end_date < block.start_date) return 'The end date cannot be before the start date.'
  if (block.end_date === block.start_date && block.start_minutes >= block.end_minutes) return 'The end time must be after the start time.'
  if (daysBetween(block.start_date, block.end_date) > 366) return 'A block can cover up to a year.'
  return ''
}
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000)

// Rows that share a group_id are one block; this describes it from its first start to its last end.
export function groupBlocks(rows) {
  const groups = new Map()
  for (const row of rows) groups.set(row.group_id, [...(groups.get(row.group_id) || []), row])
  return [...groups.values()].map(days => {
    const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date) || a.start_minutes - b.start_minutes)
    const first = sorted[0], last = sorted.at(-1)
    return { group_id: first.group_id, kind: first.kind, title: first.title || '', notes: first.notes || '',
      start_date: first.date, start_minutes: first.start_minutes, end_date: last.date, end_minutes: last.end_minutes }
  })
}

const failure = () => new Error('Could not save. Please check your connection and try again.')

export function createScheduleApi(client) {
  async function run(request) {
    const { data, error } = await request
    if (error) throw failure()
    return data
  }
  const clean = entry => ({
    available: Boolean(entry.available),
    start_minutes: entry.available ? entry.start_minutes : null,
    end_minutes: entry.available ? entry.end_minutes : null,
    start_mode: entry.available ? entry.start_mode : 'flexible',
    fixed_start_minutes: entry.available && entry.start_mode === 'fixed' ? entry.fixed_start_minutes : null,
  })
  return {
    weekly: () => run(client.from('working_hours').select('weekday,available,start_minutes,end_minutes,start_mode,fixed_start_minutes').order('weekday')),
    saveWeekly: entries => run(client.from('working_hours').upsert(entries.map(entry => ({ weekday: entry.weekday, ...clean(entry) })), { onConflict: 'weekday' })),
    overrides: from => run(client.from('working_hours_overrides').select('date,available,start_minutes,end_minutes,start_mode,fixed_start_minutes,note').gte('date', from).order('date').limit(200)),
    saveOverride: entry => run(client.from('working_hours_overrides').upsert({ date: entry.date, note: entry.note?.trim() || null, ...clean(entry) }, { onConflict: 'date' })),
    deleteOverride: date => run(client.from('working_hours_overrides').delete().eq('date', date)),
    async conflicts(date, start, end) {
      const rows = await run(client.rpc('admin_schedule_conflicts', { p_date: date, p_start_minutes: start, p_end_minutes: end }))
      return rows
    },
    // One command saves every day of a block together; groupId replaces an existing block.
    saveBlock: (groupId, block) => run(client.rpc('admin_save_block_range', { p_group_id: groupId || null, p_kind: block.kind, p_title: block.title.trim() || null, p_notes: block.notes?.trim() || null,
      p_start_date: block.start_date, p_start_minutes: block.start_minutes, p_end_date: block.end_date, p_end_minutes: block.end_minutes })),
    rangeConflicts: block => run(client.rpc('admin_block_range_conflicts', { p_start_date: block.start_date, p_start_minutes: block.start_minutes, p_end_date: block.end_date, p_end_minutes: block.end_minutes })),
    blockGroup: groupId => run(client.from('calendar_blocks').select('id,group_id,kind,title,notes,date,start_minutes,end_minutes').eq('group_id', groupId).order('date')),
    blocksFrom: from => run(client.from('calendar_blocks').select('id,group_id,kind,title,notes,date,start_minutes,end_minutes').gte('date', from).order('date').order('start_minutes').limit(800)),
    deleteBlock: groupId => run(client.from('calendar_blocks').delete().eq('group_id', groupId)),
  }
}
export const scheduleApi = createScheduleApi(supabase)
