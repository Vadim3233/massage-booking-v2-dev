import { useState } from 'react'
import { money } from '../bookingDraft.js'
import { hoursWords, lengthWord, MAX_VISIT_MINUTES, optionTotal, peopleChoices, peopleSentence, shortLength, treatmentNoun } from '../../../booking/bookingWords.js'

const COUNT = ['', 'One', 'Two', 'Three', 'Four']

// Step 3, People & length (Vadim's change request 2): first how many people, a choice of its own that nothing answers in advance, then how
// long, with every option saying how many people, how long each and the price, so "2 hours for 1 person" cannot be read as "2 people".
// Prices are the treatment's, plus the area's travel and congestion fees (extras come later); lengths that would make the visit too long are
// not offered. `choose(durations)` takes the client on to the time.
export default function PeopleLengthStep({ draft, catalogue, edit, choose }) {
  const prices = catalogue.prices.filter(price => price.service_id === draft.serviceId).sort((a, b) => a.duration_minutes - b.duration_minutes)
  const area = catalogue.areas.find(item => item.id === draft.areaId)
  const noun = treatmentNoun(catalogue.services.find(service => service.id === draft.serviceId)?.name)
  const fees = Number(area?.travel_surcharge_gbp || 0) + Number(area?.congestion_fee_gbp || 0)
  const chosen = draft.sessions.map(session => session.duration_minutes)
  // A client sent back to "Change number of people" starts with that question; otherwise the people already chosen are kept.
  const [people, setPeople] = useState(draft.askPeople || !chosen.length ? null : chosen.length)
  const mixedNow = chosen.length > 1 && chosen.some(minutes => minutes !== chosen[0])
  const [each, setEach] = useState(mixedNow ? chosen : null)
  const lengths = prices.map(price => price.duration_minutes)
  function pickPeople(count) {
    setPeople(count)
    setEach(null)
    if (draft.askPeople) edit({ askPeople: false })
  }
  if (!prices.length) return <><h1 tabIndex={-1}>How many people?</h1><p>There are no lengths available for this treatment right now. Please choose another treatment.</p></>

  if (!people) return <>
    <h1 tabIndex={-1}>How many <em>people?</em></h1>
    <p className="lede">Each person has their own massage, one after the other, at the same address.</p>
    <div className="tiles tiles--people">{peopleChoices(prices).map(count => <button key={count} className="tile tile--wide tile--people" aria-pressed={chosen.length === count && !draft.askPeople} onClick={() => pickPeople(count)}>
      <span className="tile-body"><strong className="tile-title">{count === 1 ? 'Just me' : `${count} people`}</strong>
        <span className="tile-note">{count === 1 ? `One ${noun}` : `${COUNT[count]} ${noun}s, one after the other`}</span></span>
    </button>)}</div>
    <p className="fine">Up to {hoursWords(MAX_VISIT_MINUTES)} per visit.</p>
  </>

  const sameOptions = lengths.filter(minutes => minutes * people <= MAX_VISIT_MINUTES)
  const backToPeople = <button type="button" className="btn--quiet group-toggle" onClick={() => setPeople(null)}>Change number of people</button>
  const feeParts = [
    Number(area?.travel_surcharge_gbp) > 0 && `travel fee (${money(area.travel_surcharge_gbp)})`,
    Number(area?.congestion_fee_gbp) > 0 && `congestion charge (${money(area.congestion_fee_gbp)})`,
  ].filter(Boolean)
  const feeNote = fees > 0 ? <p className="fine">Prices include the {area.name} {feeParts.join(' and ')}.</p> : null

  if (each) {
    const total = each.reduce((sum, minutes) => sum + minutes, 0)
    const price = optionTotal(prices, area, each)
    return <>
      <h1 tabIndex={-1}>How long for <em>each person?</em></h1>
      <p className="lede">{people} people, one after the other.</p>
      {each.map((minutes, index) => <fieldset className="person-length" key={index}>
        <legend>Person {index + 1}</legend>
        <div className="length-chips">{lengths.map(option => {
          const others = total - minutes
          return <button type="button" key={option} className="chip-choice" aria-pressed={minutes === option} disabled={others + option > MAX_VISIT_MINUTES}
            onClick={() => setEach(each.map((value, i) => (i === index ? option : value)))}>{shortLength(option)}</button>
        })}</div>
      </fieldset>)}
      <p className="total-line"><b>{peopleSentence(each, noun)}</b>{price !== null && <> – <span className="figure">{money(price)}</span></>}</p>
      {feeNote}
      <div className="action-bar"><button className="btn--primary btn--lg btn--block" onClick={() => choose(each)}>Choose date &amp; time</button></div>
      <button type="button" className="btn--quiet group-toggle" onClick={() => setEach(null)}>Same length for everyone</button>
      {backToPeople}
    </>
  }

  return <>
    <h1 tabIndex={-1}>{people === 1 ? <>How much time would <em>you like?</em></> : <>How long for <em>{people} people?</em></>}</h1>
    <p className="lede">{people === 1 ? 'Choose a length and you\'ll go straight on to picking a time.' : 'One after the other, at the same address. Choose a length for everyone, or a different one for each person.'}</p>
    <div className="tiles tiles--durations">{sameOptions.map(minutes => {
      const durations = Array(people).fill(minutes)
      const price = optionTotal(prices, area, durations)
      const title = people === 1 ? `${shortLength(minutes)} · 1 person` : `${people} people × ${minutes} min`
      const note = people === 1 ? `One ${lengthWord(minutes)} ${noun}` : `One after the other · ${hoursWords(minutes * people)} in total`
      return <button key={minutes} className="tile tile--wide tile--length" aria-label={`${minutes} minutes · ${people === 1 ? '1 person' : `${people} people, ${hoursWords(minutes * people)} in total`} · ${money(price)}`}
        aria-pressed={chosen.length === people && chosen.every(value => value === minutes)} onClick={() => choose(durations)}>
        <span className="tile-body"><strong className="tile-title">{title}</strong><span className="tile-note">{note}</span></span>
        <span className="tile-side"><b className="figure tile-price">{money(price)}</b></span>
      </button>
    })}</div>
    {feeNote}
    {people > 1 && <button type="button" className="btn--quiet group-toggle" onClick={() => setEach(Array(people).fill(sameOptions[0] || lengths[0]))}>Different length for each person</button>}
    {backToPeople}
  </>
}
