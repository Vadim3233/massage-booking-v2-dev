import Icon from '../../../ui/icons.jsx'
import WaitlistPanel from './WaitlistPanel.jsx'
import Welcome, { HowItWorks } from './Welcome.jsx'
import { activeHold, durationOf, money, timeLabel } from '../bookingDraft.js'
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
    <HowItWorks welcome={welcome} />
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
