import Icon from '../ui/icons.jsx'
import { dateLabel, time } from './calendarPresentation.js'
import { blockHeading, blockSpan, blockTitle, specialLine } from './agendaDays.js'

// Time away: a block over several days, or a whole day. It is one banner at its first day, and pressing it opens the block to change or remove.
export function AwayBanner({ group, open }) {
  return <div className="admin-agenda-away">
    <button type="button" onClick={() => open(group.first)}>
      <Icon name="calendar" size={20} />
      <span className="admin-agenda-away-text"><strong>{blockHeading(group)}</strong><span>{blockSpan(group)}</span></span>
      <span className="admin-agenda-away-change">Change</span>
    </button>
  </div>
}

// What is special about a day that has bookings, said in words under its date: time away, a day off, or different hours.
export function DayNotes({ special, away }) {
  if (!special && !away) return null
  return <ul role="list" className="admin-agenda-notes">
    {away && <li className="is-away"><Icon name="calendar" size={16} /><span>{blockHeading(away)}</span></li>}
    {special && <li className={special.available ? 'is-special' : 'is-off'}><Icon name="clock" size={16} /><span>{specialLine(special)}</span></li>}
  </ul>
}

// A few hours blocked on a day, among its bookings. It looks and works as it does in the Day view.
export function TimedBlock({ row, open }) {
  return <li className="admin-timeline-row admin-timeline-block">
    <time className="admin-time">{time(row.start_minutes)}</time>
    <button type="button" className="admin-timeline-entry block admin-block-button" onClick={() => open(row)}>
      <span>{blockTitle(row)}</span>
      <small>Until {time(row.end_minutes)} · tap to change</small>
    </button>
  </li>
}

// Days with nothing booked, one quiet line each. A line that stands for a block can be pressed to open it.
export function QuietDays({ items, open }) {
  return <ul role="list" className="admin-agenda-quiet" aria-label="Days without appointments">
    {items.map(item => <li key={item.id} className={`is-${item.kind}`}>
      <span className="when">{dateLabel(item.date)}</span>
      {item.row
        ? <button type="button" className="admin-agenda-quiet-button" onClick={() => open(item.row)}>{item.text}</button>
        : <span className="what">{item.text}</span>}
    </li>)}
  </ul>
}
