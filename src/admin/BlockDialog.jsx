import { useEffect, useRef, useState } from 'react'
import { clock, scheduleApi, timeOptions, validateBlock } from './scheduleApi.js'
import { acquireBodyScrollLock } from './dialogScrollLock.js'
import { dateLabel, today } from './calendarPresentation.js'

const START_OPTIONS = timeOptions(false)
const END_OPTIONS = timeOptions(true).filter(minutes => minutes > 0)

// Block time or add a personal event, or change or remove one. Warns about bookings it clashes with, never moves them.
export default function BlockDialog({ date, block, close, saved, api = scheduleApi }) {
  const ref = useRef(null)
  const confirmed = useRef(false)
  const [form, setForm] = useState(() => block
    ? { kind: block.kind, title: block.title || '', date: block.date, start_minutes: block.start_minutes, end_minutes: block.end_minutes, notes: block.notes || '' }
    : { kind: 'blocked', title: '', date, start_minutes: 720, end_minutes: 780, notes: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [conflicts, setConflicts] = useState(null)
  const [removing, setRemoving] = useState(false)
  const allDay = form.start_minutes === 0 && form.end_minutes === 1440
  const problem = validateBlock(form)

  useEffect(() => {
    const dialog = ref.current
    const opener = document.activeElement
    dialog.showModal()
    const release = acquireBodyScrollLock()
    return () => { if (dialog.open) dialog.close(); release(); opener?.focus({ preventScroll: true }) }
  }, [])

  const edit = patch => { setConflicts(null); confirmed.current = false; setForm({ ...form, ...patch }) }

  async function save(event) {
    event.preventDefault()
    if (busy || problem) return
    setBusy(true); setError('')
    try {
      if (!confirmed.current) {
        const found = await api.conflicts(form.date, form.start_minutes, form.end_minutes)
        if (found.length) { setConflicts(found); confirmed.current = true; return }
      }
      if (block) await api.updateBlock(block.id, form); else await api.createBlock(form)
      saved()
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  async function remove() {
    if (busy) return
    setBusy(true); setError('')
    try { await api.deleteBlock(block.id); saved() } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }

  return <dialog ref={ref} className="admin-confirm admin-action" aria-labelledby="block-title" onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) close() }}>
    <form onSubmit={save}>
      <h2 id="block-title">{block ? 'Change blocked time' : 'Block time'}</h2>
      <fieldset className="admin-who"><legend>What is it?</legend>
        <label><input type="radio" name="block-kind" checked={form.kind === 'blocked'} disabled={busy} onChange={() => edit({ kind: 'blocked' })} /> Time I am not available</label>
        <label><input type="radio" name="block-kind" checked={form.kind === 'personal_event'} disabled={busy} onChange={() => edit({ kind: 'personal_event' })} /> A personal event</label>
      </fieldset>
      <label className="admin-field">{form.kind === 'personal_event' ? 'Name of the event' : 'Label (optional)'}<input value={form.title} maxLength={120} disabled={busy} onChange={event => edit({ title: event.target.value })} /></label>
      <label className="admin-field">Date<input type="date" required min={block ? undefined : today()} value={form.date} disabled={busy} onChange={event => edit({ date: event.target.value })} /></label>
      <label className="admin-who-row"><input type="checkbox" checked={allDay} disabled={busy} onChange={event => edit(event.target.checked ? { start_minutes: 0, end_minutes: 1440 } : { start_minutes: 720, end_minutes: 780 })} /> All day</label>
      {!allDay && <div className="admin-hours-fields">
        <label className="admin-field">From<select value={form.start_minutes} disabled={busy} onChange={event => edit({ start_minutes: Number(event.target.value) })}>{START_OPTIONS.map(minutes => <option key={minutes} value={minutes}>{clock(minutes)}</option>)}</select></label>
        <label className="admin-field">Until<select value={form.end_minutes} disabled={busy} onChange={event => edit({ end_minutes: Number(event.target.value) })}>{END_OPTIONS.map(minutes => <option key={minutes} value={minutes}>{clock(minutes)}</option>)}</select></label>
      </div>}
      <label className="admin-field">Notes (only you see this)<textarea rows={2} maxLength={500} value={form.notes} disabled={busy} onChange={event => edit({ notes: event.target.value })} /></label>
      <p className="admin-detail-hint">Travel time around a block is kept free too.</p>
      {problem && <p role="alert" className="admin-field-error">{problem}</p>}
      {conflicts && <div role="alert" className="admin-conflicts"><strong>{dateLabel(form.date)} clashes with {conflicts.length === 1 ? 'a booking' : `${conflicts.length} bookings`}:</strong>
        <ul>{conflicts.map(item => <li key={item.booking_id}>{item.client_name}, {clock(item.start_minutes)} ({item.booking_status.replaceAll('_', ' ')})</li>)}</ul>
        <p>Those appointments will not be moved or cancelled for you. Save again if you still want to block this time.</p></div>}
      {error && <p role="alert">{error}</p>}
      {removing && <div role="alert" className="admin-conflicts"><p>Remove this {form.kind === 'personal_event' ? 'event' : 'blocked time'}? The time becomes available again.</p>
        <div className="admin-payment-buttons"><button type="button" disabled={busy} onClick={() => setRemoving(false)}>Keep it</button><button type="button" disabled={busy} onClick={remove}>{busy ? 'Removing…' : 'Yes, remove'}</button></div></div>}
      <div className="admin-payment-buttons">
        <button type="button" disabled={busy} onClick={close}>Go back</button>
        {block && !removing && <button type="button" disabled={busy} onClick={() => setRemoving(true)}>Remove</button>}
        <button type="submit" disabled={busy || Boolean(problem)}>{busy ? 'Saving…' : conflicts ? 'Save anyway' : block ? 'Save changes' : 'Block this time'}</button>
      </div>
    </form>
  </dialog>
}
