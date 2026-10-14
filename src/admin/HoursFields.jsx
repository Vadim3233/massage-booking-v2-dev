import { clock, timeOptions } from './scheduleApi.js'

// The fields that describe one day's working hours: start and end, schedule mode, first appointment and release time. They are used by the
// usual week, by a special day and by the Day settings screen, so a day is edited in the same words wherever it is.
const START_OPTIONS = timeOptions(false)
const END_OPTIONS = timeOptions(true).filter(minutes => minutes > 0)
// How a day fills up once someone has booked, said once where a day's hours are being set.
const SCHEDULE_MODE_HINT = {
  chain: "New bookings are added to the start or the end of the day's appointments, so the day stays in one run.",
  flexible: 'Clients can also choose a time between two appointments, as long as there is room for your travel time on both sides. An empty day still follows the first appointment.',
}
// What "first appointment" means, said once where a day's hours are being set.
const FIRST_APPOINTMENT_HINT = {
  flexible: 'Until someone books, clients can pick any usual time in your hours. The first booking then sets the day, and the other times are built around it.',
  fixed: 'Until someone books, clients are offered only this time. Once someone has booked, the other times are built around that booking, with your travel time. If this time has passed, or is too close for your notice period, clients see no times that day. A release time stops that: if nobody has booked by then on the day before, the day opens to any usual time in your hours.',
}

function TimeSelect({ label, value, options, onChange, disabled }) {
  return <label className="admin-field">{label}
    <select value={value ?? ''} disabled={disabled} onChange={event => onChange(event.target.value === '' ? null : Number(event.target.value))}>
      {value == null && <option value="">Choose</option>}
      {options.map(minutes => <option key={minutes} value={minutes}>{clock(minutes)}</option>)}
    </select>
  </label>
}

export function HoursFields({ entry, onChange, disabled, prefix, explain = false }) {
  if (!entry.available) return null
  const set = patch => onChange({ ...entry, ...patch })
  return <div className="admin-hours-fields">
    <TimeSelect label={`${prefix} start`} value={entry.start_minutes} options={START_OPTIONS} disabled={disabled} onChange={value => set({ start_minutes: value })} />
    <TimeSelect label={`${prefix} end`} value={entry.end_minutes} options={END_OPTIONS} disabled={disabled} onChange={value => set({ end_minutes: value })} />
    <label className="admin-field">{`${prefix} schedule mode`}
      <select value={entry.schedule_mode ?? 'chain'} disabled={disabled} onChange={event => set({ schedule_mode: event.target.value })}>
        <option value="chain">Chain (the ends of the day)</option>
        <option value="flexible">Flexible (any time that fits)</option>
      </select>
    </label>
    {explain && <p className="admin-detail-hint">{SCHEDULE_MODE_HINT[entry.schedule_mode ?? 'chain']}</p>}
    <label className="admin-field">{`${prefix} first appointment`}
      <select value={entry.start_mode} disabled={disabled} onChange={event => set({ start_mode: event.target.value, fixed_start_minutes: event.target.value === 'fixed' ? (entry.fixed_start_minutes ?? entry.start_minutes) : null, anchor_release_minutes: event.target.value === 'fixed' ? (entry.anchor_release_minutes ?? null) : null })}>
        <option value="flexible">Any time in my hours</option>
        <option value="fixed">At a set time</option>
      </select>
    </label>
    {entry.start_mode === 'fixed' && <TimeSelect label={`${prefix} first appointment time`} value={entry.fixed_start_minutes} options={START_OPTIONS} disabled={disabled} onChange={value => set({ fixed_start_minutes: value })} />}
    {entry.start_mode === 'fixed' && <label className="admin-field">{`${prefix} release time`}
      <select value={entry.anchor_release_minutes ?? ''} disabled={disabled} onChange={event => set({ anchor_release_minutes: event.target.value === '' ? null : Number(event.target.value) })}>
        <option value="">Keep it until someone books</option>
        {START_OPTIONS.map(minutes => <option key={minutes} value={minutes}>{clock(minutes)} the day before</option>)}
      </select>
    </label>}
    {explain && <p className="admin-detail-hint">{FIRST_APPOINTMENT_HINT[entry.start_mode]}</p>}
  </div>
}
