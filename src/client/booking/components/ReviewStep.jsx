import { dateLabel, money, timeLabel } from '../bookingDraft.js'

const PREFERENCE_GROUPS = [
  { title: 'Focus on', aliases: ['Focus on', 'Focus area', 'Focus'], empty: 'Optional' },
  { title: 'Pressure', aliases: ['Pressure'], empty: 'Your preference' },
  { title: 'Include', aliases: ['Include'], empty: 'Optional' },
  { title: 'Avoid', aliases: ['Avoid'], empty: 'Optional' },
]

export function PriceSummary({ quote }) {
  if (!quote) return <p role="status">Refresh your price to continue.</p>
  return <dl className="prices">{[
    ['Treatments', quote.service_subtotal_gbp], ['Enhancements', quote.enhancements_total_gbp],
    ['Travel fee', quote.travel_fee_gbp], ['Congestion fee', quote.congestion_fee_gbp], ['Total', quote.total_gbp],
  ].map(([label, amount]) => <div key={label}><dt>{label}</dt><dd>{money(amount)}</dd></div>)}</dl>
}

function preferenceConflict(preferenceId, selectedIds, conflicts) {
  return conflicts.some((conflict) =>
    (conflict.preference_id === preferenceId && selectedIds.includes(conflict.conflicting_preference_id)) ||
    (conflict.conflicting_preference_id === preferenceId && selectedIds.includes(conflict.preference_id)))
}

function preferenceSummary(group, selected) {
  if (!selected.length) return group.empty
  if (selected.length <= 2) return selected.map((preference) => preference.label).join(', ')
  return `${selected.length} selected`
}

function PreferenceGroups({ preferences, conflicts, selectedIds, change }) {
  const knownCategories = new Set(PREFERENCE_GROUPS.flatMap((group) => group.aliases))
  const groups = [
    ...PREFERENCE_GROUPS.map((group) => ({
      ...group,
      preferences: preferences.filter((preference) => group.aliases.includes(preference.category)),
    })),
    ...[...new Set(preferences.filter((preference) => !knownCategories.has(preference.category)).map((preference) => preference.category))]
      .map((category) => ({
        title: category,
        aliases: [category],
        empty: 'Optional',
        preferences: preferences.filter((preference) => preference.category === category),
      })),
  ].filter((group) => group.preferences.length)

  return <div className="preference-groups">{groups.map((group) => {
    const selected = group.preferences.filter((preference) => selectedIds.includes(preference.id))
    return <details className="preference-group" key={group.title}>
      <summary>
        <strong>{group.title}</strong>
        <span>{preferenceSummary(group, selected)}</span>
      </summary>
      <div className="preference-chips">{group.preferences.map((preference) => {
        const isSelected = selectedIds.includes(preference.id)
        const conflicting = preferenceConflict(preference.id, selectedIds, conflicts)
        return <button
          key={preference.id}
          type="button"
          className="preference-chip"
          aria-pressed={isSelected}
          disabled={!isSelected && conflicting}
          onClick={() => change(
            isSelected
              ? selectedIds.filter((id) => id !== preference.id)
              : [...selectedIds, preference.id]
          )}
        >
          {preference.label}
        </button>
      })}</div>
    </details>
  })}</div>
}

export default function ReviewStep({ draft, catalogue, quote, edit, navigate, refresh, next }) {
  function sessionEdit(index, patch) {
    edit({ sessions: draft.sessions.map((session, i) => i === index ? { ...session, ...patch } : session) })
  }
  return <><h1>Review your booking</h1><p>You can still change anything before confirming.</p>
    <section className="panel summary"><h2>Your appointment</h2>
      <button onClick={() => navigate(0)}>Area: {catalogue.areas.find((area) => area.id === draft.areaId)?.name} · Edit</button>
      <button onClick={() => navigate(1)}>Treatment: {catalogue.services.find((service) => service.id === draft.serviceId)?.name} · Edit</button>
      <button onClick={() => navigate(3)}>{dateLabel(draft.date)} at {timeLabel(draft.start)} · Edit</button>
      <button onClick={() => navigate(2)}>Sessions: {draft.sessions.map((session) => `${session.duration_minutes} min`).join(' + ')} · Edit</button>
    </section>
    {draft.sessions.map((session, index) => <section className="panel" key={index}>
      <h2>Session {index + 1} · {session.duration_minutes} minutes</h2>
      <label>Guest name (optional)<input value={session.recipient_name} maxLength={120} onChange={(event) => sessionEdit(index, { recipient_name: event.target.value })} /></label>
      <fieldset>
        <legend>Session preferences</legend>
        <PreferenceGroups
          preferences={catalogue.preferences}
          conflicts={catalogue.conflicts}
          selectedIds={session.preference_ids}
          change={(preference_ids) => sessionEdit(index, { preference_ids })}
        />
      </fieldset>
    </section>)}
    <section className="panel"><h2>Enhance your appointment</h2><p>Optional additions, applied once to your visit.</p>
      {catalogue.enhancements.map((enhancement) => <label key={enhancement.id} className="check"><input type="checkbox" checked={draft.enhancementIds.includes(enhancement.id)} onChange={() => edit({ enhancementIds: draft.enhancementIds.includes(enhancement.id) ? draft.enhancementIds.filter((id) => id !== enhancement.id) : [...draft.enhancementIds, enhancement.id] })} />{enhancement.name} · {money(enhancement.price_gbp)}<small>{enhancement.description}</small></label>)}
    </section>
    <label>Session notes (optional)<textarea maxLength={4000} value={draft.note} onChange={(event) => edit({ note: event.target.value })} /></label>
    <PriceSummary quote={quote} /><button onClick={refresh}>Refresh price</button>
    <button className="primary" onClick={next}>Continue to your details</button>
  </>
}
