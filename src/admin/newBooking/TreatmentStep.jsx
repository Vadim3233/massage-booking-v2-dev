import { money } from '../calendarPresentation.js'

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
    <label>Treatment<select required value={draft.serviceId} onChange={event => patch({ serviceId: event.target.value, start: null })}><option value="">Select treatment</option>{catalogue.services.map(service => <option key={service.id} value={service.id}>{service.name}</option>)}</select></label>
    <p className="anb-hint">One visit, up to four consecutive sessions. Maximum 240 minutes.</p>
    {draft.sessions.map((session, index) => <fieldset className="anb-session" key={index}><legend>Session {index + 1}</legend><div className="anb-fields"><label>Recipient name {index + 1}<input value={session.recipient_name} required maxLength={120} onChange={event => editSession(index, { recipient_name: event.target.value })} /></label><label>Duration {index + 1}<select value={session.duration_minutes} onChange={event => editSession(index, { duration_minutes: Number(event.target.value) })}>{[60, 90, 120].map(minutes => { const price = prices.find(item => item.duration_minutes === minutes); return <option key={minutes} value={minutes} disabled={!price || duration - session.duration_minutes + minutes > 240}>{minutes} min{price ? ` · ${money(price.price_gbp)}` : ' · Unavailable'}</option> })}</select></label></div>
      <Preferences catalogue={catalogue} selected={session.preference_ids} change={preference_ids => editSession(index, { preference_ids })} />
      {draft.sessions.length > 1 && <button type="button" onClick={() => sessionsChange(draft.sessions.filter((_, i) => index !== i))}>Remove session {index + 1}</button>}
    </fieldset>)}
    <div className="anb-inline-actions"><button type="button" disabled={draft.sessions.length >= 4 || duration + 60 > 240} onClick={() => sessionsChange([...draft.sessions, { duration_minutes: 60, recipient_name: '', preference_ids: [] }])}>+ Add session</button><span>{duration} minutes total</span></div>
    {!!catalogue.enhancements.length && <fieldset className="anb-section"><legend>Enhancements</legend><p className="anb-hint">Applied once to the visit.</p>{catalogue.enhancements.map(item => <label className="anb-radio" key={item.id}><input type="checkbox" checked={draft.enhancementIds.includes(item.id)} onChange={() => patch({ enhancementIds: draft.enhancementIds.includes(item.id) ? draft.enhancementIds.filter(id => id !== item.id) : [...draft.enhancementIds, item.id] })} /><span>{item.name} · {money(item.price_gbp)}</span></label>)}</fieldset>}
  </>
}
