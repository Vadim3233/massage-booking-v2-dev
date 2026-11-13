import Icon from '../ui/icons.jsx'
import { dateLabel, time } from './calendarPresentation.js'
import { blockHeading, blockSpan, blockTitle, dayHoursLine } from './agendaDays.js'
import { cheerLine, isDayOff } from './dayOffCheer.js'

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

// Under a day's date: time away, and the day's working hours. Special hours keep their highlight; a day off is grey; usual hours are a plain line.
export function DayNotes({ hours, away }) {
  if (!hours && !away) return null
  const kind = !hours?.available ? 'is-off' : hours.source === 'special' ? 'is-special' : 'is-usual'
  return <ul role="list" className="admin-agenda-notes">
    {away && <li className="is-away"><Icon name="calendar" size={16} /><span>{blockHeading(away)}</span></li>}
    {hours && <li className={kind}><Icon name="clock" size={16} /><span>{dayHoursLine(hours)}</span></li>}
  </ul>
}

// A few hours blocked on a day, among its bookings. It looks and works as it does in the Day view.
export function TimedBlock({ row, open }) {
  return <li className="admin-timeline-row admin-timeline-block">
    <button type="button" className="admin-timeline-entry block admin-block-button" onClick={() => open(row)}>
      <span>{blockTitle(row)}</span>
      <small>{time(row.start_minutes)} – {time(row.end_minutes)} · tap to change</small>
    </button>
  </li>
}

// Days with nothing booked, one quiet line each. A line that stands for a block can be pressed to open it.
export function QuietDays({ items, open, openDay }) {
  return <ul role="list" className="admin-agenda-quiet" aria-label="Days without appointments">
    {items.map(item => {
      const named = dateLabel(item.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      // A day off is a warm sunrise card, so it feels like a day off. Pressing it opens that day's settings, as a free day does.
      if (openDay && !item.row && isDayOff(item)) return <li key={item.id} className="is-day-off">
        <DayOffCard date={item.date} note={item.note} label={`Day settings for ${named}, ${item.text}`} onClick={() => openDay(item.date)} />
      </li>
      // A plain free day is one line that opens that day's settings wherever it is pressed.
      if (openDay && !item.row) return <li key={item.id} className={`is-${item.kind}`}>
        <button type="button" className="admin-agenda-quiet-day" aria-label={`Day settings for ${named}, ${item.text}`} onClick={() => openDay(item.date)}>
          <span className="when">{dateLabel(item.date)}</span><span className="what">{item.text}</span><Icon name="right" size={14} />
        </button>
      </li>
      // A line that stands for a block has two things to press: its date opens the day, and its words open the block.
      return <li key={item.id} className={`is-${item.kind}`}>
        {openDay
          ? <button type="button" className="admin-agenda-quiet-date" aria-label={`Day settings for ${named}`} onClick={() => openDay(item.date)}>{dateLabel(item.date)}</button>
          : <span className="when">{dateLabel(item.date)}</span>}
        {item.row
          ? <button type="button" className="admin-agenda-quiet-button" onClick={() => open(item.row)}>{item.text}</button>
          : <span className="what">{item.text}</span>}
      </li>
    })}
  </ul>
}

// The sun on the day-off card: a plain drawing with a smile, still (the Admin keeps movement for things you press).
function SmilingSun() {
  return <svg className="admin-day-off-sun" viewBox="0 0 150 150" aria-hidden="true" focusable="false">
    <g className="rays">
      <line x1="75" y1="6" x2="75" y2="24" /><line x1="75" y1="126" x2="75" y2="144" />
      <line x1="6" y1="75" x2="24" y2="75" /><line x1="126" y1="75" x2="144" y2="75" />
      <line x1="26" y1="26" x2="39" y2="39" /><line x1="111" y1="111" x2="124" y2="124" />
      <line x1="26" y1="124" x2="39" y2="111" /><line x1="111" y1="39" x2="124" y2="26" />
    </g>
    <circle className="face" cx="75" cy="75" r="36" />
    <circle className="cheek" cx="56" cy="82" r="5" /><circle className="cheek" cx="94" cy="82" r="5" />
    <circle className="eye" cx="63" cy="70" r="3.4" /><circle className="eye" cx="87" cy="70" r="3.4" />
    <path className="smile" d="M62 84 Q75 95 88 84" />
  </svg>
}

// A day off in the Agenda: the date, "Day off!", the reason given for a special day off, and a happy line that changes with the date.
export function DayOffCard({ date, note, label, onClick }) {
  return <button type="button" className="admin-day-off" aria-label={label} onClick={onClick}>
    <SmilingSun />
    <span className="admin-day-off-top"><span className="admin-day-off-date">{dateLabel(date)}</span><Icon name="right" size={16} /></span>
    <strong className="admin-day-off-title">Day off!</strong>
    {note && <span className="admin-day-off-note">{note}</span>}
    <span className="admin-day-off-line">{cheerLine(date)}</span>
  </button>
}
