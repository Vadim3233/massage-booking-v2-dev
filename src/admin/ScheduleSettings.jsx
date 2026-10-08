import { useEffect, useRef, useState } from 'react'
import { clock, scheduleApi, timeOptions, validateHours, WEEKDAYS } from './scheduleApi.js'
import { dateLabel, today } from './calendarPresentation.js'

const START_OPTIONS = timeOptions(false)
const END_OPTIONS = timeOptions(true).filter(minutes => minutes > 0)
const DEFAULT_HOURS = { available: true, start_minutes: 600, end_minutes: 1200, start_mode: 'flexible', fixed_start_minutes: null }

function TimeSelect({ label, value, options, onChange, disabled }) {
  return <label className="admin-field">{label}
    <select value={value ?? ''} disabled={disabled} onChange={event => onChange(event.target.value === '' ? null : Number(event.target.value))}>
      {value == null && <option value="">Choose</option>}
      {options.map(minutes => <option key={minutes} value={minutes}>{clock(minutes)}</option>)}
    </select>
  </label>
}

function HoursFields({ entry, onChange, disabled, prefix }) {
  if (!entry.available) return null
  const set = patch => onChange({ ...entry, ...patch })
  return <div className="admin-hours-fields">
    <TimeSelect label={`${prefix} start`} value={entry.start_minutes} options={START_OPTIONS} disabled={disabled} onChange={value => set({ start_minutes: value })} />
    <TimeSelect label={`${prefix} end`} value={entry.end_minutes} options={END_OPTIONS} disabled={disabled} onChange={value => set({ end_minutes: value })} />
    <label className="admin-field">{`${prefix} first appointment`}
      <select value={entry.start_mode} disabled={disabled} onChange={event => set({ start_mode: event.target.value, fixed_start_minutes: event.target.value === 'fixed' ? (entry.fixed_start_minutes ?? entry.start_minutes) : null })}>
        <option value="flexible">Any time in my hours</option>
        <option value="fixed">At a set time</option>
      </select>
    </label>
    {entry.start_mode === 'fixed' && <TimeSelect label={`${prefix} first appointment time`} value={entry.fixed_start_minutes} options={START_OPTIONS} disabled={disabled} onChange={value => set({ fixed_start_minutes: value })} />}
  </div>
}

function WeeklyHours({ api }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    api.weekly().then(list => { if (live) { setRows(list); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, attempt])
  if (error && !rows) return <><p role="alert">{error}</p><button onClick={() => setAttempt(value => value + 1)}>Try again</button></>
  if (!rows) return <p role="status">Loading your hours…</p>
  const update = (weekday, entry) => { setMessage(''); setRows(rows.map(row => row.weekday === weekday ? { ...entry, weekday } : row)) }
  const problems = rows.map(row => validateHours(row))
  async function save(event) {
    event.preventDefault()
    if (busy || problems.some(Boolean)) return
    setBusy(true); setError(''); setMessage('')
    try { await api.saveWeekly(rows); setMessage('Saved. New bookings will follow these hours. Appointments already booked are not moved.') }
    catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  return <form onSubmit={save} className="admin-week">
    <p className="admin-detail-hint">Your usual week. Use Special days for holidays or a one-off change.</p>
    {rows.map((row, index) => <fieldset key={row.weekday} className="admin-weekday" disabled={busy}>
      <legend>{WEEKDAYS[row.weekday - 1]}</legend>
      <label className="admin-who-row"><input type="checkbox" checked={row.available}
        onChange={event => update(row.weekday, event.target.checked ? { ...DEFAULT_HOURS, ...(row.start_minutes != null ? { start_minutes: row.start_minutes, end_minutes: row.end_minutes } : {}) } : { available: false, start_minutes: null, end_minutes: null, start_mode: 'flexible', fixed_start_minutes: null })} /> Working day</label>
      <HoursFields entry={row} prefix={WEEKDAYS[row.weekday - 1]} onChange={entry => update(row.weekday, entry)} disabled={busy} />
      {problems[index] && <p role="alert" className="admin-field-error">{problems[index]}</p>}
    </fieldset>)}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    <button type="submit" disabled={busy || problems.some(Boolean)}>{busy ? 'Saving…' : 'Save my hours'}</button>
  </form>
}

function SpecialDays({ api }) {
  const [list, setList] = useState(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [conflicts, setConflicts] = useState(null)
  const confirmed = useRef(false)
  useEffect(() => {
    let live = true
    api.overrides(today()).then(rows => { if (live) { setList(rows); setError('') } }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, attempt])
  const open = entry => { setMessage(''); setConflicts(null); confirmed.current = false; setForm(entry) }
  const edit = patch => { setConflicts(null); confirmed.current = false; setForm({ ...form, ...patch }) }
  const problem = form ? (form.date ? (form.date < today() ? 'Choose a date from today onwards.' : validateHours(form)) : 'Choose a date.') : ''

  async function save(event) {
    event.preventDefault()
    if (busy || problem) return
    setBusy(true); setError('')
    try {
      if (!confirmed.current) {
        const ranges = form.available ? [[0, form.start_minutes], [form.end_minutes, 1440]].filter(([from, to]) => to > from) : [[0, 1440]]
        const found = (await Promise.all(ranges.map(([from, to]) => api.conflicts(form.date, from, to)))).flat()
        if (found.length) { setConflicts(found); confirmed.current = true; return }
      }
      await api.saveOverride(form)
      setForm(null); setConflicts(null); setMessage('Saved.'); setAttempt(value => value + 1)
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  async function remove(date) {
    if (busy) return
    setBusy(true); setError('')
    try { await api.deleteOverride(date); setMessage('Removed. That day follows your usual week again.'); setAttempt(value => value + 1) }
    catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  return <section>
    <p className="admin-detail-hint">Days off, holidays and days with different hours. These replace your usual week for that date.</p>
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
    {!form && <button onClick={() => open({ date: '', available: false, start_minutes: null, end_minutes: null, start_mode: 'flexible', fixed_start_minutes: null, note: '' })}>Add a special day</button>}
    {form && <form className="admin-special-form" onSubmit={save}>
      <h3>{list?.some(item => item.date === form.date) ? 'Change a special day' : 'Add a special day'}</h3>
      <label className="admin-field">Date<input type="date" required min={today()} value={form.date} disabled={busy} onChange={event => edit({ date: event.target.value })} /></label>
      <fieldset className="admin-who"><legend>What is happening?</legend>
        <label><input type="radio" name="special-kind" checked={!form.available} disabled={busy} onChange={() => edit({ available: false, start_minutes: null, end_minutes: null, start_mode: 'flexible', fixed_start_minutes: null })} /> Day off</label>
        <label><input type="radio" name="special-kind" checked={form.available} disabled={busy} onChange={() => edit({ available: true, start_minutes: form.start_minutes ?? 600, end_minutes: form.end_minutes ?? 1200 })} /> Different hours</label>
      </fieldset>
      <HoursFields entry={form} prefix="Special day" onChange={setForm} disabled={busy} />
      <label className="admin-field">Note (only you see this)<input value={form.note || ''} maxLength={200} disabled={busy} onChange={event => edit({ note: event.target.value })} /></label>
      {problem && <p role="alert" className="admin-field-error">{problem}</p>}
      {conflicts && <div role="alert" className="admin-conflicts"><strong>This clashes with {conflicts.length === 1 ? 'a booking' : `${conflicts.length} bookings`}:</strong>
        <ul>{conflicts.map(item => <li key={item.booking_id}>{item.client_name}, {clock(item.start_minutes)} ({item.booking_status.replaceAll('_', ' ')})</li>)}</ul>
        <p>Those appointments will not be moved or cancelled for you. Save again if you still want to make this change.</p></div>}
      <div className="admin-payment-buttons">
        <button type="button" disabled={busy} onClick={() => setForm(null)}>Cancel</button>
        <button type="submit" disabled={busy || Boolean(problem)}>{busy ? 'Saving…' : conflicts ? 'Save anyway' : 'Save'}</button>
      </div>
    </form>}
    {!list && !error && <p role="status">Loading special days…</p>}
    {list && !list.length && !form && <p>No special days coming up.</p>}
    {list?.length > 0 && <ul className="admin-special-list">{list.map(item => <li key={item.date}>
      <div><strong>{dateLabel(item.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</strong>
        <span>{item.available ? `${clock(item.start_minutes)}–${clock(item.end_minutes)}` : 'Day off'}{item.note ? ` · ${item.note}` : ''}</span></div>
      <div className="admin-payment-buttons"><button disabled={busy} onClick={() => open({ ...item, note: item.note || '' })}>Change</button><button disabled={busy} onClick={() => remove(item.date)}>Remove</button></div>
    </li>)}</ul>}
  </section>
}

export default function ScheduleSettings({ api = scheduleApi }) {
  const [tab, setTab] = useState('weekly')
  return <section className="admin-review" aria-labelledby="schedule-title">
    <header className="admin-review-heading"><div><h1 id="schedule-title">Working hours</h1></div></header>
    <div className="admin-tabs" role="tablist" aria-label="Working hours sections">
      <button role="tab" aria-selected={tab === 'weekly'} onClick={() => setTab('weekly')}>Usual week</button>
      <button role="tab" aria-selected={tab === 'days'} onClick={() => setTab('days')}>Special days</button>
    </div>
    {tab === 'weekly' ? <WeeklyHours api={api} /> : <SpecialDays api={api} />}
  </section>
}
