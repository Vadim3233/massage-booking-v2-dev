import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { createBookingApi } from '../booking/bookingApi.js'
import { money, timeLabel } from '../booking/bookingDraft.js'
import { dayParts } from '../booking/dateStrip.js'
import { guestLabel } from '../../booking/guestNames.js'
import { hoursWords } from '../../booking/bookingWords.js'
import DayTimePicker from '../booking/components/DayTimePicker.jsx'
import { canAddPerson, lengthFits, LENGTHS, moneyLines, newPerson, peopleChanged, peopleFromBooking, personPrice, totalMinutes } from '../../booking/bookingChange.js'

const bookingApi = createBookingApi(supabase)

// A client changing who is coming, each person's treatment and length, and the time with them (Vadim's rules, 11 Nov 2026). The price and what
// it means for their money come from the database before anything is saved; only the usual times for the new length are offered, worked out
// as if this booking were not there (chain mode). The current time stays chosen when it is still one of them.
export default function ChangePanel({ booking, rules, done, back, api, catalogue: loadCatalogue = () => bookingApi.catalogue() }) {
  const [catalogue, setCatalogue] = useState(null)
  const [people, setPeople] = useState(() => peopleFromBooking(booking))
  const [plan, setPlan] = useState(null)
  const [planError, setPlanError] = useState('')
  const [slot, setSlot] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const request = useRef(null)
  const minutes = totalMinutes(people)
  const changed = peopleChanged(booking, people)

  useEffect(() => {
    let live = true
    loadCatalogue().then(value => { if (live) setCatalogue(value) }, () => { if (live) setError("I couldn't load the treatments. Please try again.") })
    return () => { live = false }
    // Loaded once for this form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // The new price, asked for again a moment after each change (so typing a name does not ask on every key).
  const asked = JSON.stringify([people.map(({ id, service_id, duration_minutes, recipient_name }) => [id, service_id, duration_minutes, recipient_name]), reload])
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      api.changePreview(booking.id, people).then(value => { if (live) { setPlan({ asked, value }); setPlanError('') } },
        failure => { if (live) { setPlan(null); setPlanError(failure.message) } })
    }, 300)
    return () => { live = false; clearTimeout(timer) }
    // `asked` stands for people.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, booking.id, asked])
  const current = plan?.asked === asked ? plan.value : null
  // The current time stays chosen while it is still offered for the new length; a time picked for another length is let go.
  const [kept, setKept] = useState(null)
  useEffect(() => {
    let live = true
    api.changeTimes(booking.id, booking.date, minutes).then(starts => { if (live) setKept({ minutes, ok: starts.includes(booking.start_minutes) }) }, () => { if (live) setKept({ minutes, ok: false }) })
    return () => { live = false }
  }, [api, booking.id, booking.date, booking.start_minutes, minutes, reload])
  const picked = slot?.minutes === minutes ? slot : null
  const chosen = picked || (kept?.minutes === minutes && kept.ok ? { date: booking.date, start: booking.start_minutes, minutes } : null)
  const moved = chosen && (chosen.date !== booking.date || chosen.start !== booking.start_minutes)

  const services = useMemo(() => {
    const list = [...(catalogue?.services || [])]
    for (const person of people) if (person.service_id && !list.some(item => item.id === person.service_id)) list.push({ id: person.service_id, name: person.name })
    return list
  }, [catalogue, people])
  const prices = catalogue?.prices || []
  function edit(index, values) { setPeople(list => list.map((person, i) => (i === index ? { ...person, ...values } : person))); setError('') }

  const ready = Boolean(current) && Boolean(chosen) && !busy && (changed || moved)
  async function submit(event) {
    event.preventDefault()
    if (!ready) return
    setBusy(true); setError('')
    const key = JSON.stringify([asked, chosen.date, chosen.start, current.total_gbp])
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    try { done(await api.change(booking.id, request.current.id, people, chosen.date, chosen.start, Number(current.total_gbp))) }
    catch (failure) { setError(failure.message); if (failure.refresh) { setSlot(null); setReload(value => value + 1) } }
    finally { setBusy(false) }
  }

  return <form className="panel account-change" onSubmit={submit}>
    <h2 tabIndex={-1}>Change your booking</h2>
    <p>Change who is coming, the treatment or the length. Then choose a time that suits the new length.</p>
    {!catalogue && !error && <p role="status">Loading treatments…</p>}
    {people.map((person, index) => <fieldset className="person-length account-person" key={person.id || `new-${index}`} disabled={busy}>
      <legend>{people.length > 1 ? `Person ${index + 1}` : 'Your treatment'}</legend>
      {people.length > 1 && <label>Name (optional)<input value={person.recipient_name} maxLength={120} placeholder={guestLabel(index)} onChange={event => edit(index, { recipient_name: event.target.value })} /></label>}
      <label>Treatment<select value={person.service_id || ''} onChange={event => edit(index, { service_id: event.target.value, name: services.find(item => item.id === event.target.value)?.name || '' })}>
        {!person.service_id && <option value="">Choose a treatment</option>}
        {services.map(service => <option key={service.id} value={service.id}>{service.name}</option>)}
      </select></label>
      <div className="length-chips" role="group" aria-label={`Length for person ${index + 1}`}>{LENGTHS.map(length => {
        const price = personPrice(booking, { ...person, duration_minutes: length }, prices)
        return <button type="button" key={length} className="chip-choice" aria-pressed={Number(person.duration_minutes) === length}
          disabled={price === null || !lengthFits(people, index, length)} onClick={() => edit(index, { duration_minutes: length })}>
          {length} min{price !== null && ` · ${money(price)}`}</button>
      })}</div>
      {people.length > 1 && <button type="button" className="btn--quiet btn--small" onClick={() => setPeople(list => list.filter((_, i) => i !== index))}>Remove {person.recipient_name.trim() || `person ${index + 1}`}</button>}
    </fieldset>)}
    <p className="account-change-total">
      <button type="button" className="btn--quiet btn--small" disabled={busy || !canAddPerson(people)} onClick={() => setPeople(list => [...list, newPerson(list)])}>+ Add a person</button>
      <span>{hoursWords(minutes)} in all</span>
    </p>

    <h3>Time</h3>
    <DayTimePicker key={booking.id} horizonDays={rules.horizonDays} dateLabel="Date" initialDate={booking.date} reloadKey={`${minutes}:${reload}`}
      loadDay={date => api.changeTimes(booking.id, date, minutes)} selected={chosen}
      onPick={(date, start) => { setSlot({ date, start, minutes }); setError('') }} emptyMessage="There are no times on that day for this length. Please try another date." />
    {chosen
      ? <p className="account-note" role="status">{moved ? 'New time' : 'Time'}: <strong>{dayParts(chosen.date).long}, {timeLabel(chosen.start)}–{timeLabel(chosen.start + minutes)}</strong></p>
      : kept?.minutes === minutes && <p className="account-note" role="status">Your current time doesn't work for this length. Please choose a time above.</p>}

    <div className={`account-note${current && Number(current.balance_due_gbp) > 0 ? ' account-note--fee' : ''}`} role="status" aria-live="polite">
      {current ? moneyLines(current, 'client').map(line => <p key={line}>{line}</p>) : planError ? <p>{planError}</p> : <p>Working out the price…</p>}
    </div>

    {error && <p role="alert" className="error">{error}</p>}
    <div className="actions">
      <button type="button" disabled={busy} onClick={back}>Back</button>
      <button type="submit" className="btn--primary" disabled={!ready}>{busy ? 'Saving…' : current ? `Save the change · ${money(current.total_gbp)}` : 'Save the change'}</button>
    </div>
  </form>
}
