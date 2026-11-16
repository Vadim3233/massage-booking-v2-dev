import Icon from '../ui/icons.jsx'

// The icon for each kind of line. The day is in the heading above the lines, so a line only needs the time.
const ICONS = { cash: 'cash', bank: 'bank', gift: 'gift', booking: 'calendar', cancel: 'cross', people: 'users', other: 'bell', move: 'move',
  edit: 'edit', clock: 'clock', check: 'check', pin: 'pin', receipt: 'receipt', send: 'send' }

// Old value crossed out, new value in bold: "Fri 20 Nov 10:00 → Sat 21 Nov 14:00".
export function Changes({ changes }) {
  if (!changes?.length) return null
  return <span className="activity-changes">{changes.map((change, index) => <span key={index} className="activity-change">
    <s><span className="admin-sr-only">was </span>{change.from}</s><span aria-hidden="true" className="activity-arrow">→</span><b><span className="admin-sr-only">now </span>{change.to || '(none)'}</b>
  </span>)}</span>
}

export function WhoChip({ line }) {
  return <span className={`activity-who is-${line.actor || 'system'}`}>{line.actorLabel}</span>
}

export function Tags({ tags }) {
  if (!tags?.length) return null
  return <>{tags.map(tag => <span key={tag.text} className={`activity-tag ${tag.tone === 'late' ? 'is-late' : ''}`}>{tag.text}</span>)}</>
}

// The icon, then what happened (with "3×" if it happened several times in a row), the change, and who.
export function LineBody({ line, side }) {
  return <>
    <span className={`admin-alert-icon is-${line.kind}`}><Icon name={ICONS[line.kind] || 'bell'} size={18} />{line.unread && <span className="admin-sr-only">New: </span>}</span>
    <span className="admin-alert-text">
      <strong>{line.what}{line.times > 1 && <span className="activity-times"> · {line.times}×</span>}</strong>
      <Changes changes={line.changes} />
      <span className="activity-sub"><WhoChip line={line} />{line.who && <span>{line.who}</span>}<Tags tags={line.tags} /></span>
    </span>
    {side}
  </>
}
