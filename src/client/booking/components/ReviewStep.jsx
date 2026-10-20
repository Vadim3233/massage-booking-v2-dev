import { useEffect } from 'react'
import { money, timeLabel, durationOf } from '../bookingDraft.js'
import { quoteParams } from '../bookingApi.js'
import { dayParts } from '../dateStrip.js'
import { guestLabel } from '../../../booking/guestNames.js'
import { bookingSentence, peopleSentence, treatmentNoun } from '../../../booking/bookingWords.js'

const PREFERENCE_GROUPS = [
  { title: 'Focus on', aliases: ['Focus on', 'Focus area', 'Focus'] },
  { title: 'Pressure', aliases: ['Pressure'] },
  { title: 'Include', aliases: ['Include'] },
  { title: 'Avoid', aliases: ['Avoid'] },
]

// The price, with the lines that are nothing left out: a fee of £0.00 is not worth a row.
export function PriceSummary({ quote, quoteError, retry }) {
  if (!quote && quoteError) return <div className="price-state" role="alert"><p>{quoteError}</p><button className="btn--small" onClick={retry}>Try again</button></div>
  if (!quote) return <div className="skeleton-rows price-skeleton" role="status"><span className="sr-only">Updating the price…</span><span className="skeleton" /></div>
  const rows = [
    ['Treatments', quote.service_subtotal_gbp, true], ['Extras', quote.enhancements_total_gbp], ['Travel fee', quote.travel_fee_gbp], ['Congestion fee', quote.congestion_fee_gbp],
  ].filter(([, amount, always]) => always || Number(amount) > 0)
  return <dl className="prices">
    {rows.map(([label, amount]) => <div key={label}><dt>{label}</dt><dd>{money(amount)}</dd></div>)}
    <div className="prices-total"><dt>Total</dt><dd className="figure">{money(quote.total_gbp)}</dd></div>
  </dl>
}

function preferenceConflict(preferenceId, selectedIds, conflicts) {
  return conflicts.some((conflict) =>
    (conflict.preference_id === preferenceId && selectedIds.includes(conflict.conflicting_preference_id)) ||
    (conflict.conflicting_preference_id === preferenceId && selectedIds.includes(conflict.preference_id)))
}

function PreferenceGroups({ preferences, conflicts, selectedIds, change }) {
  const knownCategories = new Set(PREFERENCE_GROUPS.flatMap((group) => group.aliases))
  const groups = [
    ...PREFERENCE_GROUPS.map((group) => ({ title: group.title, preferences: preferences.filter((preference) => group.aliases.includes(preference.category)) })),
    ...[...new Set(preferences.filter((preference) => !knownCategories.has(preference.category)).map((preference) => preference.category))]
      .map((category) => ({ title: category, preferences: preferences.filter((preference) => preference.category === category) })),
  ].filter((group) => group.preferences.length)

  return <div className="preference-groups">{groups.map((group) => <div className="preference-group" role="group" aria-label={group.title} key={group.title}>
    <p className="preference-title">{group.title}</p>
    <div className="preference-chips">{group.preferences.map((preference) => {
      const isSelected = selectedIds.includes(preference.id)
      const conflicting = preferenceConflict(preference.id, selectedIds, conflicts)
      return <button
        key={preference.id}
        type="button"
        className="preference-chip"
        aria-pressed={isSelected}
        disabled={!isSelected && conflicting}
        onClick={() => change(isSelected ? selectedIds.filter((id) => id !== preference.id) : [...selectedIds, preference.id])}
      >
        {preference.label}
      </button>
    })}</div>
  </div>)}</div>
}

export default function ReviewStep({ draft, catalogue, quote, quoteError, edit, navigate, refreshQuote, retryQuote, next }) {
  const total = durationOf(draft)
  const choices = JSON.stringify(quoteParams(draft))
  // The price follows the choices by itself, a moment after the last change, so there is no button to remember.
  useEffect(() => {
    if (quote || quoteError) return undefined
    const timer = setTimeout(refreshQuote, 350)
    return () => clearTimeout(timer)
  }, [quote, quoteError, choices, refreshQuote])

  function sessionEdit(index, patch) {
    edit({ sessions: draft.sessions.map((session, i) => i === index ? { ...session, ...patch } : session) })
  }
  const chosenCount = draft.sessions.reduce((sum, session) => sum + session.preference_ids.length, 0)
  const area = catalogue.areas.find((item) => item.id === draft.areaId)?.name
  const service = catalogue.services.find((item) => item.id === draft.serviceId)?.name
  const many = draft.sessions.length > 1
  const row = (label, text, step) => <div><dt>{label}</dt><dd><span className="row-text">{text}</span><button className="btn--quiet btn--small" aria-label={`Change ${label.toLowerCase()}`} onClick={() => navigate(step)}>Change</button></dd></div>
  const durations = draft.sessions.map((session) => session.duration_minutes)
  // One plain sentence of who, how long and the price (from the database's quote), so the number of people cannot be misread.
  const sentence = quote ? bookingSentence(durations, quote.total_gbp, treatmentNoun(service)) : peopleSentence(durations, treatmentNoun(service))
  return <><h1 tabIndex={-1}>Review your <em>booking</em></h1><p className="lede">Nothing is booked yet, so you can still change anything here.</p>
    <div className="people-sentence"><p><strong>{sentence}</strong></p>
      <button type="button" className="btn--quiet btn--small" onClick={() => { edit({ askPeople: true }); navigate(2) }}>Change number of people</button></div>
    <section className="ticket" aria-label="Your appointment">
      <div className="ticket-head">
        <div>
          <p className="eyebrow">When</p>
          <p className="ticket-when figure">{dayParts(draft.date).long}</p>
          <p className="ticket-time">{timeLabel(draft.start)}–{timeLabel(draft.start + total)} <span>London time</span></p>
        </div>
        <button className="btn--quiet btn--small" aria-label="Change date and time" onClick={() => navigate(3)}>Change</button>
      </div>
      <dl className="ticket-rows">
        {row('Treatment', service, 1)}
        {row('Length', draft.sessions.map((session) => `${session.duration_minutes} min`).join(' + '), 2)}
        {row('Area', area, 0)}
      </dl>
    </section>
    <details className="more">
      <summary><span className="more-title">Your preferences</span><span className="more-hint">{chosenCount ? `${chosenCount} chosen` : 'Optional'}</span></summary>
      <div className="more-body">
        {draft.sessions.map((session, index) => <div className="person" key={index}>
          {many && <h2 className="person-title">{guestLabel(index)} · {session.duration_minutes} minutes</h2>}
          {many && <label>Name for {guestLabel(index)} (optional)<input value={session.recipient_name} placeholder={guestLabel(index)} maxLength={120} onChange={(event) => sessionEdit(index, { recipient_name: event.target.value })} /></label>}
          <PreferenceGroups preferences={catalogue.preferences} conflicts={catalogue.conflicts} selectedIds={session.preference_ids} change={(preference_ids) => sessionEdit(index, { preference_ids })} />
        </div>)}
      </div>
    </details>
    {catalogue.enhancements.length > 0 && <section className="addons" aria-labelledby="addons-title"><h2 id="addons-title" className="section-title">Extras <span className="optional">optional</span></h2>
      {catalogue.enhancements.map((enhancement) => <label key={enhancement.id} className="check addon">
        <input type="checkbox" checked={draft.enhancementIds.includes(enhancement.id)} onChange={() => edit({ enhancementIds: draft.enhancementIds.includes(enhancement.id) ? draft.enhancementIds.filter((id) => id !== enhancement.id) : [...draft.enhancementIds, enhancement.id] })} />
        <span className="addon-text"><b>{enhancement.name}</b>{enhancement.description && <small>{enhancement.description}</small>}</span>
        <span className="addon-price">{Number(enhancement.price_gbp) > 0 ? `+${money(enhancement.price_gbp)}` : 'Free'}</span>
      </label>)}
    </section>}
    <label className="field-note">Anything I should know? (optional)<textarea maxLength={4000} rows={3} value={draft.note} onChange={(event) => edit({ note: event.target.value })} /></label>
    <p className="fine">If anything medical affects your treatment, it's best to tell me directly rather than write it here.</p>
    <PriceSummary quote={quote} quoteError={quoteError} retry={retryQuote} />
    <p className="sr-only" role="status">{quote ? `Total ${money(quote.total_gbp)}` : ''}</p>
    <div className="action-bar">
      <p className="action-summary"><span>Total</span><b className="figure">{quote ? money(quote.total_gbp) : '–'}</b></p>
      <button className="btn--primary btn--lg" onClick={next}>Continue to your details</button>
    </div>
  </>
}
