import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { createCalendarApi } from './calendarApi.js'
import { cleanDay, clock, conflictRanges, DAY_OFF, hoursLine, scheduleApi, validateHours, weekdayOf, WEEKDAYS } from './scheduleApi.js'
import { bookingsLine, dayState, hoursChanged, isDate, isDirty, settingsLine, workingDay } from './daySettings.js'
import { blockTitle } from './agendaDays.js'
import { HoursFields } from './HoursFields.jsx'
import BookingCard from './BookingCard.jsx'
import { dateLabel, shiftDate, time, today } from './calendarPresentation.js'
import './daySettings.css'

const BlockDialog = lazy(() => import('./BlockDialog.jsx'))
const calendar = createCalendarApi(supabase)

// One date on its own: what it is set to and why, the hours and schedule that can be changed for just this date, the time blocked on it and
// the bookings on it. The hours are saved as a special day, the same record the Special days list shows.
export default function DaySettings({ date, revision, openBooking, changed, api = scheduleApi }) {
  const valid = isDate(date)
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)
  // The form as it has been changed, or null while it is as saved. Nothing is copied out of what was read, so a new read shows at once.
  const [edits, setEdits] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [conflicts, setConflicts] = useState(null)
  const [blockDialog, setBlockDialog] = useState(null)
  const confirmed = useRef(false)
  const heading = useRef(null)
  // A screen that loads a moment after it is opened is read out from its heading. The Admin's own move of focus can land on the page it
  // replaced, which is still there, hidden, while this one loads, so the heading takes focus itself once it is on screen.
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [])

  const read = useCallback(() => calendar.loadCalendarRange(date, shiftDate(date, 1))
    .then(result => ({ date, bookings: result.bookings, blocks: result.blocks, state: dayState(date, result) })), [date])
  useEffect(() => {
    if (!valid) return undefined
    let live = true
    read().then(result => { if (live) { setData(result); setLoadError('') } }, () => { if (live) setLoadError('Could not load this day. Please check your connection and try again.') })
    return () => { live = false }
  }, [valid, read, attempt, revision])
  // After a change, what was saved is shown straight away and the day is read again quietly to be sure.
  const refresh = replacement => { setData(previous => previous && { ...previous, state: { ...previous.state, ...replacement } }); read().then(setData, () => {}) }

  if (!valid) return <section className="admin-review admin-day-settings" aria-labelledby="day-settings-title">
    <h1 id="day-settings-title">Day settings</h1>
    <p role="alert">That is not a date. Go back and choose a day from the Agenda or the Day view.</p>
  </section>

  const state = data?.state
  const saved = state?.saved
  const form = edits ?? saved
  const dirty = Boolean(saved) && isDirty(saved, form)
  const past = date < today()
  const problem = form ? validateHours(form) : ''
  const weekday = WEEKDAYS[weekdayOf(date) - 1]
  const full = dateLabel(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  const edit = entry => { setError(''); setMessage(''); setConflicts(null); confirmed.current = false; setEdits(entry) }
  const setWorking = on => edit(on ? workingDay(state.usual, form.note) : { ...DAY_OFF, note: form.note })

  async function save(event) {
    event.preventDefault()
    if (busy || !dirty || problem || past) return
    setBusy(true); setError('')
    try {
      // Only changed hours can leave a booking outside them. A different schedule mode or first appointment moves nobody.
      if (!confirmed.current && hoursChanged(saved, form)) {
        const found = (await Promise.all(conflictRanges(form).map(([from, to]) => api.conflicts(date, from, to)))).flat()
        if (found.length) { setConflicts(found); confirmed.current = true; return }
      }
      await api.saveOverride({ ...form, date })
      setEdits(null); setConflicts(null); confirmed.current = false
      setMessage('Saved. This day now has its own settings.')
      refresh({ special: true, saved: { ...cleanDay(form), note: (form.note || '').trim() } })
      changed?.()
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  async function useUsualWeek() {
    if (busy) return
    setBusy(true); setError('')
    try {
      await api.deleteOverride(date)
      setEdits(null); setConflicts(null); confirmed.current = false
      setMessage(`Removed. This day follows your usual ${weekday} again.`)
      refresh({ special: false, saved: { ...state.usual, note: '' } })
      changed?.()
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  const blocksChanged = () => { setBlockDialog(null); read().then(setData, () => {}); changed?.() }

  return <section className="admin-review admin-day-settings" aria-labelledby="day-settings-title">
    <h1 id="day-settings-title" ref={heading} tabIndex={-1}>Day settings</h1>
    <p className="admin-day-settings-date">{full}</p>

    {loadError && !data && <div role="alert" className="error"><p>{loadError}</p><button className="btn--small" onClick={() => setAttempt(value => value + 1)}>Try again</button></div>}
    {!data && !loadError && <div className="skeleton-rows" role="status"><span className="sr-only">Loading this day…</span><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>}

    {data && <>
      <section className="admin-day-glance" aria-label="This day at a glance">
        <p className="admin-day-glance-main">{settingsLine(saved)}</p>
        <p>{bookingsLine(data.bookings)}</p>
        <p className="admin-detail-hint">{state.special
          ? `A special day${saved.note ? `: ${saved.note}` : ''}. It replaces your usual ${weekday}.`
          : `Follows your usual ${weekday}: ${state.usual.available ? hoursLine(state.usual) : 'a day off'}.`}</p>
      </section>
      {loadError && <p role="status" className="admin-detail-hint">Could not refresh this day just now. <button className="btn--small" onClick={() => setAttempt(value => value + 1)}>Try again</button></p>}

      <form className="admin-special-form admin-day-settings-form" onSubmit={save} aria-labelledby="day-hours-title">
        <h2 id="day-hours-title">Hours and schedule</h2>
        {past
          ? <p className="admin-detail-hint">This day has passed, so its settings cannot be changed. Its bookings are below.</p>
          : <p className="admin-detail-hint">What you change here is for {full} only. Your usual {weekday} stays as it is.</p>}
        <label className="admin-who-row"><input type="checkbox" checked={form.available} disabled={busy || past} onChange={event => setWorking(event.target.checked)} /> Working day</label>
        <HoursFields entry={form} prefix="This day" onChange={edit} disabled={busy || past} explain />
        <label className="admin-field">Note (only you see this)<input value={form.note || ''} maxLength={200} disabled={busy || past} onChange={event => edit({ ...form, note: event.target.value })} /></label>
        {problem && <p role="alert" className="admin-field-error">{problem}</p>}
        {conflicts && <div role="alert" className="admin-conflicts"><strong>This clashes with {conflicts.length === 1 ? 'a booking' : `${conflicts.length} bookings`}:</strong>
          <ul>{conflicts.map(item => <li key={item.booking_id}>{item.client_name}, {clock(item.start_minutes)} ({item.booking_status.replaceAll('_', ' ')})</li>)}</ul>
          <p>Those appointments will not be moved or cancelled for you. Save again if you still want to make this change.</p></div>}
        {error && <p role="alert">{error}</p>}
        {message && !dirty && <p role="status">{message}</p>}
        {dirty && !busy && <p role="status" className="admin-detail-hint">You have changes that are not saved yet.</p>}
        {!past && <div className="admin-day-settings-actions">
          <button type="submit" className="btn--primary btn--lg btn--block" disabled={busy || !dirty || Boolean(problem)}>{busy ? 'Saving…' : conflicts ? 'Save anyway' : 'Save this day'}</button>
          {state.special && <button type="button" className="btn--quiet btn--block" disabled={busy} onClick={useUsualWeek}>Use my usual week</button>}
        </div>}
      </form>

      <section aria-labelledby="day-blocks-title" className="admin-day-settings-section">
        <h2 id="day-blocks-title">Blocked time</h2>
        {data.blocks.length > 0
          ? <ul role="list" className="admin-special-list">{data.blocks.map(row => <li key={row.id}>
            <div><strong>{row.kind === 'series_hold' ? 'Kept free for a repeating client' : blockTitle(row)}</strong>
              <span>{row.start_minutes === 0 && row.end_minutes === 1440 ? 'All day' : `${time(row.start_minutes)}–${time(row.end_minutes)}`}</span></div>
            {row.kind !== 'series_hold' && <div className="admin-payment-buttons"><button type="button" className="btn--small" aria-label={`Change ${blockTitle(row)}, ${row.start_minutes === 0 && row.end_minutes === 1440 ? 'all day' : `${time(row.start_minutes)} to ${time(row.end_minutes)}`}`} onClick={() => setBlockDialog({ date, block: row })}>Change</button></div>}
          </li>)}</ul>
          : <p>Nothing is blocked on this day.</p>}
        {!past && <button type="button" className="btn--tonal" onClick={() => setBlockDialog({ date })}>Block time</button>}
      </section>

      <section aria-labelledby="day-bookings-title" className="admin-day-settings-section">
        <h2 id="day-bookings-title">Bookings</h2>
        {data.bookings.length > 0
          ? <ol role="list" className="admin-timeline" aria-label={`Bookings for ${full}`}>{data.bookings.map(booking => <li key={booking.id} className="admin-timeline-row admin-timeline-booking">
            <time className="admin-time"><span className="figure">{time(booking.start_minutes)}</span><small>{booking.treatment_duration_minutes} min</small></time>
            <BookingCard booking={booking} open={() => openBooking(booking.id)} now={new Date()} />
          </li>)}</ol>
          : <p>No bookings on this day.</p>}
      </section>
    </>}
    {blockDialog && <Suspense fallback={null}><BlockDialog date={blockDialog.date} block={blockDialog.block} close={() => setBlockDialog(null)} saved={blocksChanged} /></Suspense>}
  </section>
}
