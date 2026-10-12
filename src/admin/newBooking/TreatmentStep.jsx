import { money } from '../calendarPresentation.js'
import { guestLabel } from '../../booking/guestNames.js'

function Preferences({ catalogue, selected, change }) {
  const categories = [...new Set(catalogue.preferences.map(preference => preference.category))]
  return <div className="anb-preferences">{categories.map(category => <details key={category}><summary>{category}<span>{catalogue.preferences.filter(item => item.category === category && selected.includes(item.id)).map(item => item.label).join(', ') || 'Optional'}</span></summary><div className="anb-chips">{catalogue.preferences.filter(item => item.category === category).map(item => {
    const chosen = selected.includes(item.id)
    const conflict = catalogue.conflicts.some(pair => (pair.preference_id === item.id && selected.includes(pair.conflicting_preference_id)) || (pair.conflicting_preference_id === item.id && selected.includes(pair.preference_id)))
    return <button type="button" key={item.id} aria-pressed={chosen} disabled={!chosen && conflict} onClick={() => change(chosen ? selected.filter(id => id !== item.id) : [...selected, item.id])}>{item.label}</button>
  })}</div></details>)}</div>
}

export default function TreatmentStep({ draft, catalogue, patch }) {
  const duration = draft.sessions.reduce((sum, session) => sum + session.duration_minutes, 0)
  const prices = catalogue.prices.filter(price => price.service_id === draft.serviceId)
  function sessionsChange(sessions) { patch({ sessions, start: null }) }
  function editSession(index, values) { sessionsChange(draft.sessions.map((session, i) => index === i ? { ...session, ...values } : session)) }
  return <>
    <fieldset className="anb-choice"><legend>Treatment</legend><div className="anb-choices">{catalogue.services.map(service => <label className="anb-chip" key={service.id}><input type="radio" name="admin-treatment" checked={draft.serviceId === service.id} onChange={() => patch({ serviceId: service.id, start: null })} /><span>{service.name}</span></label>)}</div></fieldset>
    {draft.sessions.map((session, index) => <fieldset className="anb-session" key={index}><legend className={draft.sessions.length > 1 ? undefined : 'sr-only'}>Session {index + 1}</legend>{draft.sessions.length > 1 && <label>Name for {guestLabel(index)} (optional)<input value={session.recipient_name} placeholder={guestLabel(index)} maxLength={120} onChange={event => editSession(index, { recipient_name: event.target.value })} /></label>}<fieldset className="anb-choice"><legend>Length{draft.sessions.length > 1 ? ` for session ${index + 1}` : ''}</legend><div className="anb-choices">{[60, 90, 120].map(minutes => { const price = prices.find(item => item.duration_minutes === minutes); const unavailable = !price || duration - session.duration_minutes + minutes > 240; return <label className="anb-chip anb-chip--length" key={minutes}><input type="radio" name={`admin-length-${index}`} checked={session.duration_minutes === minutes} disabled={unavailable} onChange={() => editSession(index, { duration_minutes: minutes })} /><span>{minutes} min<small>{price ? money(price.price_gbp) : 'Unavailable'}</small></span></label> })}</div></fieldset>
      <details className="anb-more" open={session.preference_ids.length > 0 || undefined}><summary>Session preferences (optional)</summary><Preferences catalogue={catalogue} selected={session.preference_ids} change={preference_ids => editSession(index, { preference_ids })} /></details>
      {draft.sessions.length > 1 && <button type="button" onClick={() => sessionsChange(draft.sessions.filter((_, i) => index !== i))}>Remove session {index + 1}</button>}
    </fieldset>)}
    <details className="anb-more" open={draft.sessions.length > 1 || draft.enhancementIds.length > 0 || undefined}><summary>More options: another person, extras</summary>
    <p className="anb-hint">One visit, up to four consecutive sessions. Maximum 240 minutes.</p>
    <div className="anb-inline-actions"><button type="button" disabled={draft.sessions.length >= 4 || duration + 60 > 240} onClick={() => sessionsChange([...draft.sessions, { duration_minutes: 60, recipient_name: '', preference_ids: [] }])}>+ Add session</button><span>{duration} minutes total</span></div>
    {!!catalogue.enhancements.length && <fieldset className="anb-section"><legend>Enhancements</legend><p className="anb-hint">Applied once to the visit.</p>{catalogue.enhancements.map(item => <label className="anb-radio" key={item.id}><input type="checkbox" checked={draft.enhancementIds.includes(item.id)} onChange={() => patch({ enhancementIds: draft.enhancementIds.includes(item.id) ? draft.enhancementIds.filter(id => id !== item.id) : [...draft.enhancementIds, item.id] })} /><span>{item.name} · {money(item.price_gbp)}</span></label>)}</fieldset>}
    </details>
  </>
}
