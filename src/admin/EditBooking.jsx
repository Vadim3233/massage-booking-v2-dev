import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { canAddPerson, lengthFits, LENGTHS, moneyLines, newPerson, peopleChanged, peopleFromBooking, personPrice, totalMinutes } from '../booking/bookingChange.js'
import { guestLabel } from '../booking/guestNames.js'
import { hoursWords } from '../booking/bookingWords.js'
import { clientName, dateLabel, money, time, today } from './calendarPresentation.js'
import { acquireBodyScrollLock } from './dialogScrollLock.js'
import { editBookingApi } from './editBookingApi.js'
import { lifecycleApi } from './bookingLifecycleApi.js'
import DayTimePicker from '../client/booking/components/DayTimePicker.jsx'
import AllTimes from './newBooking/AllTimes.jsx'
import './editBooking.css'

// Edit booking (Vadim's rules, 11 Nov 2026): who is coming, each person's treatment, length and name, and the date and time, in one step.
// The new price and what it means for the money come from the database before anything is saved. Inside the free-cancellation window the
// price does not go down unless "Lower the price anyway" is ticked. The client is told unless "Send the client the new details" is unticked.
export default function EditBooking({ booking, close, done, api = editBookingApi, times = lifecycleApi }) {
  const ref = useRef(null)
  const request = useRef(null)
  const [catalogue, setCatalogue] = useState(null)
  const [people, setPeople] = useState(() => peopleFromBooking(booking))
  const [moving, setMoving] = useState(false)
  const [slot, setSlot] = useState(null)
  const [notify, setNotify] = useState(true)
  const [lowerPrice, setLowerPrice] = useState(false)
  const [plan, setPlan] = useState(null)
  const [planError, setPlanError] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const minutes = totalMinutes(people)
  const changed = peopleChanged(booking, people)

  useEffect(() => {
    const dialog = ref.current
    const opener = document.activeElement
    dialog.showModal()
    const release = acquireBodyScrollLock()
    return () => { if (dialog.open) dialog.close(); release(); opener?.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => {
    let live = true
    api.catalogue().then(value => { if (live) setCatalogue(value) }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api])
  // The new price, asked for again a moment after each change (so typing a name does not ask on every key).
  const asked = JSON.stringify([people.map(({ id, service_id, duration_minutes, recipient_name }) => [id, service_id, duration_minutes, recipient_name]), lowerPrice])
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      api.preview(booking.id, people, lowerPrice).then(value => { if (live) { setPlan({ asked, value }); setPlanError('') } },
        failure => { if (live) { setPlan(null); setPlanError(failure.message) } })
    }, 300)
    return () => { live = false; clearTimeout(timer) }
    // `asked` stands for people and lowerPrice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, booking.id, asked])
  const current = plan?.asked === asked ? plan.value : null
  // A different length of visit needs a time that fits it, so a time chosen for another length is let go.
  const chosen = slot?.minutes === minutes ? slot : null

  const loadDay = useCallback(date => times.availability(date, minutes, booking.id), [times, minutes, booking.id])
  const loadTimes = useCallback((date, duration) => times.times(date, duration, booking.id), [times, booking.id])
  const services = useMemo(() => {
    const list = [...(catalogue?.services || [])]
    // A treatment no longer shown still appears for the person who has it, so it is not changed by accident.
    for (const person of people) if (person.service_id && !list.some(item => item.id === person.service_id)) list.push({ id: person.service_id, name: `${person.name} (no longer offered)` })
    return list
  }, [catalogue, people])

  function edit(index, values) { setPeople(list => list.map((person, i) => (i === index ? { ...person, ...values } : person))); setError('') }
  const longer = minutes > Number(booking.treatment_duration_minutes)
  const ready = Boolean(current) && !busy && (changed || (moving && chosen) || current.total_gbp !== current.previous_total_gbp) && (!moving || Boolean(chosen))

  async function submit(event) {
    event.preventDefault()
    if (!ready) return
    setBusy(true); setError('')
    const change = { people, slot: moving ? chosen : null, notify, lowerPrice }
    const key = JSON.stringify([booking.updated_at, asked, change.slot, notify])
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    try {
      await api.save(booking, request.current.id, change)
      await done('Booking changed.')
    } catch (failure) {
      setError(failure.message)
      setReloadKey(value => value + 1)
      if (failure.conflict) await done(failure.message, true)
    } finally { setBusy(false) }
  }

  const prices = catalogue?.prices || []
  return <dialog ref={ref} className="admin-confirm admin-action aeb" aria-labelledby="edit-booking-title" onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) close() }}>
    <form onSubmit={submit}>
      <h2 id="edit-booking-title">Edit booking</h2>
      <div className="admin-confirm-summary"><strong>{clientName(booking)}</strong><span>{dateLabel(booking.date)} · {time(booking.start_minutes)}</span><b className="figure">{money(booking.total_gbp)}</b></div>

      <fieldset className="aeb-people" disabled={busy}><legend>Who is coming</legend>
        {!catalogue && !error && <p role="status">Loading treatments…</p>}
        {people.map((person, index) => <fieldset className="aeb-person" key={person.id || `new-${index}`}>
          <legend>{people.length > 1 ? `Person ${index + 1}` : 'Person'}</legend>
          <label className="admin-field">Name (optional)<input value={person.recipient_name} maxLength={120} placeholder={people.length > 1 ? guestLabel(index) : ''} onChange={event => edit(index, { recipient_name: event.target.value })} /></label>
          <label className="admin-field">Treatment<select value={person.service_id || ''} onChange={event => edit(index, { service_id: event.target.value, name: services.find(item => item.id === event.target.value)?.name || '' })}>
            {!person.service_id && <option value="">Choose a treatment</option>}
            {services.map(service => <option key={service.id} value={service.id}>{service.name}</option>)}
          </select></label>
          <div className="aeb-lengths" role="radiogroup" aria-label={`Length for person ${index + 1}`}>{LENGTHS.map(length => {
            const price = personPrice(booking, { ...person, duration_minutes: length }, prices)
            const fits = lengthFits(people, index, length)
            return <label className="aeb-chip" key={length}><input type="radio" name={`aeb-length-${index}`} checked={Number(person.duration_minutes) === length} disabled={price === null || !fits}
              onChange={() => edit(index, { duration_minutes: length })} /><span>{length} min<small>{price === null ? 'Not offered' : money(price)}</small></span></label>
          })}</div>
          {people.length > 1 && <button type="button" className="btn--quiet btn--small" onClick={() => setPeople(list => list.filter((_, i) => i !== index))}>Remove {person.recipient_name.trim() || `person ${index + 1}`}</button>}
        </fieldset>)}
        <div className="aeb-add"><button type="button" disabled={!canAddPerson(people)} onClick={() => setPeople(list => [...list, newPerson(list)])}>+ Add a person</button><span>{hoursWords(minutes)} in all</span></div>
      </fieldset>

      <fieldset className="admin-who" disabled={busy}><legend>Date and time</legend>
        <label><input type="radio" name="aeb-when" checked={!moving} onChange={() => setMoving(false)} /> Keep {dateLabel(booking.date)} at {time(booking.start_minutes)}</label>
        <label><input type="radio" name="aeb-when" checked={moving} onChange={() => setMoving(true)} /> Choose a new date or time</label>
      </fieldset>
      {!moving && <p className="admin-detail-hint">{time(booking.start_minutes)}–{time(booking.start_minutes + minutes)}{longer ? '. Made longer, it must not run into anything after it.' : ''}</p>}
      {moving && <>
        <DayTimePicker horizonDays={365} dateLabel="New date" initialDate={booking.date >= today() ? booking.date : today()} reloadKey={`${minutes}:${reloadKey}`}
          loadDay={loadDay} selected={chosen} onPick={(date, start) => { setSlot({ date, start, anyTime: false, notes: [], minutes }); setError('') }} emptyMessage="No usual times for this length. Choose another date, or show all times."
          renderFooter={date => <AllTimes date={date} duration={minutes} selectedStart={chosen?.date === date ? chosen.start : null} selectedNotes={chosen?.anyTime ? chosen.notes : []}
            onPick={(day, start, choice) => { setSlot({ date: day, start, ...choice, minutes }); setError('') }} loadTimes={loadTimes} reloadKey={reloadKey} />} />
        {chosen && <p className="admin-new-time" role="status">New time: {dateLabel(chosen.date, { weekday: 'short', day: 'numeric', month: 'short' })} · {time(chosen.start)}–{time(chosen.start + minutes)}{chosen.anyTime && ' · outside your usual times'}</p>}
      </>}

      <div className="admin-money-outcome" role="status" aria-live="polite">
        <span>Price and payment</span>
        {current ? moneyLines(current, 'admin').map(line => <strong key={line}>{line}</strong>) : planError ? <strong>{planError}</strong> : <small>Working out the price…</small>}
      </div>
      {current?.inside_window && (current.price_kept || lowerPrice) && <label className="admin-who-row aeb-check"><input type="checkbox" checked={lowerPrice} disabled={busy} onChange={event => setLowerPrice(event.target.checked)} /> Lower the price anyway (normally the price stays the same within {current.free_cancellation_hours ?? 24} hours)</label>}
      <label className="admin-who-row aeb-check"><input type="checkbox" checked={notify} disabled={busy} onChange={event => setNotify(event.target.checked)} /> Send the client the new details (email and Telegram)</label>

      {error && <p role="alert">{error}</p>}
      <div className="admin-payment-buttons admin-sticky-actions">
        <button type="submit" className="btn--primary" disabled={!ready}>{busy ? 'Saving…' : current ? `Save · ${money(current.total_gbp)}` : 'Save'}</button>
        <button type="button" className="btn--quiet" disabled={busy} onClick={close}>Go back</button>
      </div>
    </form>
  </dialog>
}
