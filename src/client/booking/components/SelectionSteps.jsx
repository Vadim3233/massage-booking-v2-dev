import { useEffect, useState } from 'react'
import { activeHold, dateLabel, durationOf, londonDate, money, newSession, timeLabel } from '../bookingDraft.js'

export function AreaStep({ catalogue, choose }) {
  const [expanded, setExpanded] = useState(false)
  return <>
    <h1>Choose your area</h1>
    <div className="choices">{catalogue.areas.slice(0, expanded ? undefined : 6).map((area) => <button key={area.id} onClick={() => choose(area.id)}>
      <strong>{area.name}</strong>
      {Number(area.travel_surcharge_gbp) > 0 && <span>Travel surcharge {money(area.travel_surcharge_gbp)}</span>}
      {Number(area.congestion_fee_gbp) > 0 && <span>Congestion charge {money(area.congestion_fee_gbp)}</span>}
    </button>)}</div>
    {catalogue.areas.length > 6 && <button onClick={() => setExpanded(!expanded)}>{expanded ? 'Show fewer areas' : 'Show more areas'}</button>}
    {!catalogue.areas.length && <p>Online booking areas are being updated.</p>}
    <p>I visit selected parts of these areas. Outside my usual route? <a href="https://vadmassage.com">Contact Vad</a> to arrange your visit.</p>
  </>
}

export function TreatmentStep({ catalogue, choose }) {
  return <><h1>What would help you most today?</h1><p>Choose the treatment that feels closest to what you need.</p>
    <div className="choices">{catalogue.services.map((service) => <button key={service.id} onClick={() => choose(service.id)}>
      <strong>{service.name}</strong><span>{service.short_description || service.long_description}</span>
    </button>)}</div>{!catalogue.services.length && <p>No treatments are currently available. Please contact Vad.</p>}
  </>
}

export function DurationStep({ draft, catalogue, change, next }) {
  const total = durationOf(draft)
  const prices = catalogue.prices.filter((price) => price.service_id === draft.serviceId)
  return <><h1>How much time would you like?</h1><p>Select a session for each person. Sessions run consecutively at the same address.</p>
    {prices.map((price) => {
      const count = draft.sessions.filter((session) => session.duration_minutes === price.duration_minutes).length
      return <div className="quantity" key={price.duration_minutes}>
        <div><strong>{price.duration_minutes} minutes</strong><span>{money(price.price_gbp)} per person</span></div>
        <button aria-label={`Remove ${price.duration_minutes} minutes`} disabled={!count} onClick={() => {
          const index = draft.sessions.findLastIndex((session) => session.duration_minutes === price.duration_minutes)
          change(draft.sessions.filter((_, i) => i !== index))
        }}>−</button><output aria-label={`${price.duration_minutes} minute sessions`}>{count}</output>
        <button aria-label={`Add ${price.duration_minutes} minutes`} disabled={total + price.duration_minutes > 240} onClick={() => change([...draft.sessions, newSession(price.duration_minutes)])}>+</button>
      </div>
    })}
    {!prices.length && <p>This treatment currently has no bookable durations. Please select another treatment.</p>}
    <p>{draft.sessions.length} session(s) · {total} minutes. Maximum 240 minutes per visit.</p>
    <button className="primary" disabled={!total} onClick={next}>Choose date &amp; time</button>
  </>
}

export function TimeStep({ draft, loadAvailability, selectDate, selectSlot, next }) {
  const [availability, setAvailability] = useState({ slots: [], loading: true, error: '' })
  const [availabilityAttempt, setAvailabilityAttempt] = useState(0)
  const duration = durationOf(draft)
  useEffect(() => {
    let live = true
    if (!draft.date) {
      setAvailability({ slots: [], loading: false, error: '' })
      return
    }
    setAvailability({ slots: [], loading: true, error: '' })
    loadAvailability(draft.date, duration).then((slots) => {
      if (live) setAvailability({ slots, loading: false, error: '' })
    }).catch((error) => {
      if (live) setAvailability({
        slots: [],
        loading: false,
        error: error.message || 'Unable to load available times. Please retry.',
      })
    })
    return () => { live = false }
  }, [loadAvailability, draft.date, draft.hold?.hold_id, draft.hold?.hold_token, duration, availabilityAttempt])
  const slots = availability.slots.map((slot) => slot.start_minutes)
  return <><h1>Choose date and time</h1><p>All appointment times are London time.</p>
    <label>Appointment date<input type="date" value={draft.date} min={londonDate()} max={londonDate(40)} onChange={(event) => selectDate(event.target.value)} /></label>
    <p>{dateLabel(draft.date)}</p>
    {availability.loading && draft.date && <p role="status">Loading available times…</p>}
    {availability.error && <div>
      <p className="error" role="alert">{availability.error}</p>
      <button type="button" onClick={() => setAvailabilityAttempt((attempt) => attempt + 1)}>Retry available times</button>
    </div>}
    <div className="slots" aria-label="Available times">{slots.sort((a, b) => a - b).map((start) => <button key={start} aria-pressed={draft.start === start && activeHold(draft)} onClick={() => selectSlot(start)}>{timeLabel(start)}</button>)}</div>
    {!availability.loading && !slots.length && <p>No suitable times on this day. Choose another date or <a href="https://vadmassage.com">contact Vad</a>.</p>}
    <button className="primary" disabled={!activeHold(draft)} onClick={next}>Review booking</button>
  </>
}
