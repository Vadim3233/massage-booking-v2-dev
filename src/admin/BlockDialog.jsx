import { useEffect, useRef, useState } from 'react'
import { clock, daysBetween, groupBlocks, scheduleApi, timeOptions, validateBlock } from './scheduleApi.js'
import { acquireBodyScrollLock } from './dialogScrollLock.js'
import { dateLabel, today } from './calendarPresentation.js'

const START_OPTIONS = timeOptions(false)
const END_OPTIONS = timeOptions(true).filter(minutes => minutes > 0)

const stamp = (date, minutes) => `${dateLabel(date, { weekday: 'short', day: 'numeric', month: 'short' })} ${clock(minutes)}`

// Block time or add a personal event over a date and time range, or change or remove one. Warns about bookings
// it clashes with, never moves them. A block over several days is one block: changes and removal apply to all its days.
export default function BlockDialog({ date, block, close, saved, api = scheduleApi }) {
  const ref = useRef(null)
  const confirmed = useRef(false)
  const [form, setForm] = useState(() => block
    ? { kind: block.kind, title: block.title || '', start_date: block.date, end_date: block.date, start_minutes: block.start_minutes, end_minutes: block.end_minutes, notes: block.notes || '' }
    : { kind: 'blocked', title: '', start_date: date, end_date: date, start_minutes: 720, end_minutes: 780, notes: '' })
  const [loading, setLoading] = useState(Boolean(block))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [conflicts, setConflicts] = useState(null)
  const [removing, setRemoving] = useState(false)
  const allDay = form.start_minutes === 0 && form.end_minutes === 1440
  const problem = validateBlock(form)
  const days = form.start_date && form.end_date ? daysBetween(form.start_date, form.end_date) + 1 : 1

  useEffect(() => {
    const dialog = ref.current
    const opener = document.activeElement
    dialog.showModal()
    const release = acquireBodyScrollLock()
    return () => { if (dialog.open) dialog.close(); release(); opener?.focus({ preventScroll: true }) }
  }, [])
  // The row that was tapped is one day of the block; fetch every day so the whole block can be shown and changed.
  useEffect(() => {
    if (!block) return undefined
    let live = true
    api.blockGroup(block.group_id).then(rows => { if (live && rows.length) setForm(groupBlocks(rows)[0]) })
      .catch(() => {}).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [api, block])

  const edit = patch => {
    setConflicts(null); confirmed.current = false
    const next = { ...form, ...patch }
    if (next.end_date < next.start_date) next.end_date = next.start_date
    setForm(next)
  }

  async function save(event) {
    event.preventDefault()
    if (busy || problem) return
    setBusy(true); setError('')
    try {
      if (!confirmed.current) {
        const found = await api.rangeConflicts(form)
        if (found.length) { setConflicts(found); confirmed.current = true; return }
      }
      await api.saveBlock(block?.group_id, form)
      saved()
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  async function remove() {
    if (busy) return
    setBusy(true); setError('')
    try { await api.deleteBlock(block.group_id); saved() } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }

  return <dialog ref={ref} className="admin-confirm admin-action" aria-labelledby="block-title" onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) close() }}>
    <form onSubmit={save}>
      <h2 id="block-title">{block ? 'Change blocked time' : 'Block time'}</h2>
      <fieldset className="admin-who"><legend>What is it?</legend>
        <label><input type="radio" name="block-kind" checked={form.kind === 'blocked'} disabled={busy} onChange={() => edit({ kind: 'blocked' })} /> Time I am not available</label>
        <label><input type="radio" name="block-kind" checked={form.kind === 'personal_event'} disabled={busy} onChange={() => edit({ kind: 'personal_event' })} /> A personal event</label>
      </fieldset>
      <label className="admin-field">{form.kind === 'personal_event' ? 'Name of the event' : 'Label (optional)'}<input value={form.title} maxLength={120} disabled={busy} onChange={event => edit({ title: event.target.value })} /></label>
      <label className="admin-who-row"><input type="checkbox" checked={allDay} disabled={busy || loading} onChange={event => edit(event.target.checked ? { start_minutes: 0, end_minutes: 1440 } : { start_minutes: 720, end_minutes: 780 })} /> All day</label>
      <div className="admin-hours-fields">
        <label className="admin-field">Start date<input type="date" required min={block ? undefined : today()} value={form.start_date} disabled={busy || loading} onChange={event => edit({ start_date: event.target.value })} /></label>
        <label className="admin-field">End date<input type="date" required min={form.start_date || undefined} value={form.end_date} disabled={busy || loading} onChange={event => edit({ end_date: event.target.value })} /></label>
      </div>
      {!allDay && <div className="admin-hours-fields">
        <label className="admin-field">Start time<select value={form.start_minutes} disabled={busy} onChange={event => edit({ start_minutes: Number(event.target.value) })}>{START_OPTIONS.map(minutes => <option key={minutes} value={minutes}>{clock(minutes)}</option>)}</select></label>
        <label className="admin-field">End time<select value={form.end_minutes} disabled={busy} onChange={event => edit({ end_minutes: Number(event.target.value) })}>{END_OPTIONS.map(minutes => <option key={minutes} value={minutes}>{clock(minutes)}</option>)}</select></label>
      </div>}
      {!problem && <p className="admin-detail-hint" role="status">{allDay
        ? (days === 1 ? `${dateLabel(form.start_date, { weekday: 'long', day: 'numeric', month: 'long' })}, all day` : `${dateLabel(form.start_date, { weekday: 'short', day: 'numeric', month: 'short' })} to ${dateLabel(form.end_date, { weekday: 'short', day: 'numeric', month: 'short' })}, ${days} whole days`)
        : (days === 1 ? `${stamp(form.start_date, form.start_minutes)} to ${clock(form.end_minutes)}` : `${stamp(form.start_date, form.start_minutes)} to ${stamp(form.end_date, form.end_minutes)}, ${days} days`)}</p>}
      <label className="admin-field">Notes (only you see this)<textarea rows={2} maxLength={500} value={form.notes} disabled={busy} onChange={event => edit({ notes: event.target.value })} /></label>
      <p className="admin-detail-hint">Travel time around a block is kept free too.</p>
      {problem && <p role="alert" className="admin-field-error">{problem}</p>}
      {conflicts && <div role="alert" className="admin-conflicts"><strong>This clashes with {conflicts.length === 1 ? 'a booking' : `${conflicts.length} bookings`}:</strong>
        <ul>{conflicts.map(item => <li key={item.booking_id}>{dateLabel(item.date, { weekday: 'short', day: 'numeric', month: 'short' })}, {item.client_name}, {clock(item.start_minutes)} ({item.booking_status.replaceAll('_', ' ')})</li>)}</ul>
        <p>Those appointments will not be moved or cancelled for you. Save again if you still want to block this time.</p></div>}
      {error && <p role="alert">{error}</p>}
      {removing && <div role="alert" className="admin-conflicts"><p>Remove this {form.kind === 'personal_event' ? 'event' : 'blocked time'}{days > 1 ? ` (all ${days} days)` : ''}? The time becomes available again.</p>
        <div className="admin-payment-buttons"><button type="button" disabled={busy} onClick={() => setRemoving(false)}>Keep it</button><button type="button" disabled={busy} onClick={remove}>{busy ? 'Removing…' : 'Yes, remove'}</button></div></div>}
      <div className="admin-payment-buttons">
        <button type="button" disabled={busy} onClick={close}>Go back</button>
        {block && !removing && <button type="button" disabled={busy} onClick={() => setRemoving(true)}>Remove</button>}
        <button type="submit" disabled={busy || loading || Boolean(problem)}>{busy ? 'Saving…' : conflicts ? 'Save anyway' : block ? 'Save changes' : 'Block this time'}</button>
      </div>
    </form>
  </dialog>
}
