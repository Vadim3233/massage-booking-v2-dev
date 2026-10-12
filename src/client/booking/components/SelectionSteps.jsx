import { useState } from 'react'
import Icon from '../../../ui/icons.jsx'
import WaitlistPanel from './WaitlistPanel.jsx'
import Welcome from './Welcome.jsx'
import { activeHold, durationOf, money, newSession, timeLabel } from '../bookingDraft.js'
import DayTimePicker from './DayTimePicker.jsx'
import { dayParts } from '../dateStrip.js'

const surcharges = area => [
  Number(area.travel_surcharge_gbp) > 0 && `Travel +${money(area.travel_surcharge_gbp)}`,
  Number(area.congestion_fee_gbp) > 0 && `Congestion +${money(area.congestion_fee_gbp)}`,
].filter(Boolean)

export function AreaStep({ catalogue, choose, welcome, rules, usual, bookUsual }) {
  return <>
    <Welcome welcome={welcome} rules={rules} usual={usual} bookUsual={bookUsual} />
    <h2 className="section-title">Choose your area</h2>
    <div className="tiles tiles--areas">{catalogue.areas.map((area) => <button className="tile" key={area.id} onClick={() => choose(area.id)}>
      <strong className="tile-title">{area.name}</strong>
      {surcharges(area).map(note => <span className="tile-note" key={note}>{note}</span>)}
    </button>)}</div>
    {!catalogue.areas.length && <p>Online booking areas are being updated.</p>}
    <p className="fine">I visit selected parts of these areas. Outside my usual route? <a href="https://vadmassage.com">Get in touch</a> and I'll see what I can arrange.</p>
  </>
}

export function TreatmentStep({ catalogue, choose }) {
  const from = id => {
    const prices = catalogue.prices.filter((price) => price.service_id === id).map((price) => Number(price.price_gbp))
    return prices.length ? Math.min(...prices) : null
  }
  return <><h1 tabIndex={-1}>What would help you <em>most today?</em></h1><p className="lede">Choose the treatment that feels closest to what you need.</p>
    <div className="tiles">{catalogue.services.map((service) => <button className="tile tile--wide" key={service.id} onClick={() => choose(service.id)}>
      <span className="tile-body">
        <strong className="tile-title tile-title--display">{service.name}</strong>
        <span className="tile-note">{service.short_description || service.long_description}</span>
      </span>
      <span className="tile-side">{from(service.id) !== null && <span className="tile-from">From <b className="figure">{money(from(service.id))}</b></span>}<Icon name="right" size={20} className="tile-chevron" /></span>
    </button>)}</div>{!catalogue.services.length && <p>No treatments are currently available. Please contact Vad.</p>}
  </>
}

export function DurationStep({ draft, catalogue, change, choose, next }) {
  const [group, setGroup] = useState(draft.sessions.length > 1)
  const total = durationOf(draft)
  const prices = catalogue.prices.filter((price) => price.service_id === draft.serviceId)
  const treatments = draft.sessions.reduce((sum, session) => sum + Number(prices.find((price) => price.duration_minutes === session.duration_minutes)?.price_gbp || 0), 0)
  return <><h1 tabIndex={-1}>How much time would <em>you like?</em></h1>
    {!group && <>
      <p className="lede">Choose a length and you'll go straight on to picking a time.</p>
      <div className="tiles tiles--durations">{prices.map((price) => <button className="tile tile--duration" key={price.duration_minutes} aria-label={`${price.duration_minutes} minutes ${money(price.price_gbp)} per person`}
        aria-pressed={draft.sessions.length === 1 && draft.sessions[0].duration_minutes === price.duration_minutes} onClick={() => choose(price.duration_minutes)}>
        <span className="figure tile-figure">{price.duration_minutes}</span>{' '}<span className="tile-unit">minutes</span>{' '}<span className="tile-price">{money(price.price_gbp)}</span>
      </button>)}</div>
      {prices.length > 0 && <button className="btn--quiet group-toggle" onClick={() => setGroup(true)}>Booking for more than one person?</button>}
    </>}
    {group && <>
      <p className="lede">Choose a session for each person. Sessions run one after another at the same address.</p>
      {prices.map((price) => {
        const count = draft.sessions.filter((session) => session.duration_minutes === price.duration_minutes).length
        return <div className="quantity" key={price.duration_minutes}>
          <div><strong>{price.duration_minutes} minutes</strong><span>{money(price.price_gbp)} per person</span></div>
          <div className="stepper-control">
            <button type="button" aria-label={`Remove ${price.duration_minutes} minutes`} aria-disabled={!count} onClick={() => {
              if (!count) return
              const index = draft.sessions.findLastIndex((session) => session.duration_minutes === price.duration_minutes)
              change(draft.sessions.filter((_, i) => i !== index))
            }}><Icon name="minus" size={20} /></button>
            <output aria-label={`${price.duration_minutes} minute sessions`}>{count}</output>
            <button type="button" aria-label={`Add ${price.duration_minutes} minutes`} aria-disabled={total + price.duration_minutes > 240} onClick={() => { if (total + price.duration_minutes <= 240) change([...draft.sessions, newSession(price.duration_minutes)]) }}><Icon name="plus" size={20} /></button>
          </div>
        </div>
      })}
      <p className="total-line">{total ? <><b>{draft.sessions.length} {draft.sessions.length === 1 ? 'session' : 'sessions'}</b> · {total} minutes · treatments {money(treatments)}</> : 'No sessions chosen yet.'} <span className="fine">Up to 240 minutes per visit.</span></p>
      <div className="action-bar"><button className="btn--primary btn--lg btn--block" disabled={!total} onClick={next}>Choose date &amp; time</button></div>
      <button className="btn--quiet group-toggle" onClick={() => setGroup(false)}>Just me</button>
    </>}
    {!prices.length && <p>There are no lengths available for this treatment right now. Please choose another treatment.</p>}
  </>
}

const shortDay = (date) => { const parts = dayParts(date); return `${parts.weekday} ${parts.day} ${parts.month}` }

export function TimeStep({ rules, draft, loadAvailability, selectSlot, next, joinWaitlist }) {
  const duration = durationOf(draft)
  const held = activeHold(draft)
  const holdKey = `${draft.hold?.hold_id}:${draft.hold?.hold_token}`
  const chosen = held && draft.date && draft.start != null
  return <><h1 tabIndex={-1}>Choose date <em>and time</em></h1><p className="lede">All appointment times are London time.</p>
    <DayTimePicker key={duration} horizonDays={rules.horizonDays} initialDate={draft.date} reloadKey={holdKey}
      loadDay={(date) => loadAvailability(date, duration).then((rows) => rows.map((row) => row.start_minutes))}
      selected={chosen ? { date: draft.date, start: draft.start } : null} onPick={(date, start) => selectSlot(start, date)}
      emptyMessage={<>No suitable times on this day. Choose another date or <a href="https://vadmassage.com">contact Vad</a>.</>}
      renderEmpty={(date) => joinWaitlist && <WaitlistPanel key={`${date}:${duration}`} date={date} duration={duration} join={joinWaitlist} />} />
    <div className="action-bar">
      <p className="action-summary" aria-live="polite">{chosen ? <><b>{shortDay(draft.date)}</b><span>{timeLabel(draft.start)}–{timeLabel(draft.start + duration)}</span></> : <span>Choose a time to continue</span>}</p>
      <button className="btn--primary btn--lg" disabled={!held} onClick={next}>Review booking</button>
    </div>
  </>
}
