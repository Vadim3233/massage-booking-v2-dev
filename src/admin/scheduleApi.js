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
export function validateBlock(block) {
  if (!block.date) return 'Choose a date.'
  if (block.kind === 'personal_event' && !block.title.trim()) return 'Give the personal event a name.'
  if (block.start_minutes >= block.end_minutes) return 'The end time must be after the start time.'
  return ''
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
    async createBlock(block) {
      const { data: user } = await client.auth.getUser()
      return run(client.from('calendar_blocks').insert({ kind: block.kind, date: block.date, start_minutes: block.start_minutes, end_minutes: block.end_minutes,
        title: block.title.trim() || null, notes: block.notes?.trim() || null, created_by: user?.user?.id || null }))
    },
    updateBlock: (id, block) => run(client.from('calendar_blocks').update({ kind: block.kind, date: block.date, start_minutes: block.start_minutes, end_minutes: block.end_minutes,
      title: block.title.trim() || null, notes: block.notes?.trim() || null }).eq('id', id)),
    deleteBlock: id => run(client.from('calendar_blocks').delete().eq('id', id)),
  }
}
export const scheduleApi = createScheduleApi(supabase)
