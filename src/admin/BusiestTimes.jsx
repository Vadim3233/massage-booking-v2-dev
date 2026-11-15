import { useEffect, useMemo, useState } from 'react'
import { whatsappNumber } from './contactLinks.js'
import { DAYS, MONTHS, PARTS, busySummary, freeWords, headline, plural, pounds, quietDayTip, ranked, rowMeta, shortDay, usualWords, verdictWords, wantedTip, wantedWords, weekday } from './busyTimes.js'

const VIEWS = [['days', 'Days'], ['times', 'Times'], ['months', 'Months'], ['hols', 'Holidays']]
const monthYear = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'short', year: 'numeric' })
const fullWords = row => row.full === null || row.full === undefined ? '' : ` · ${row.full}% full`

// Income › Busiest times (ADR-103): every visit since the first one, whatever period the page above shows. Four answers at a glance, ideas
// to act on this week (the quietest day with the regulars who usually come then and are due, times people wanted when full, a bank holiday
// coming up), a ranking for each question, and the Monday "Your week" Telegram switch.
// If the database change is not applied yet, the section stays hidden and the page works as before.
export default function BusiestTimes({ api, openDay, openHours }) {
  const [data, setData] = useState(null)
  const [view, setView] = useState('days')
  const [by, setBy] = useState('bookings')
  const [weekly, setWeekly] = useState({ on: false, busy: false, error: '' })
  useEffect(() => {
    let live = true
    if (!api.busy) return undefined
    api.busy().then(value => { if (live) { setData(value); setWeekly(current => ({ ...current, on: Boolean(value?.weekly_summary) })) } }, () => { if (live) setData(false) })
    return () => { live = false }
  }, [api])
  const summary = useMemo(() => data ? busySummary(data) : null, [data])
  if (!summary) return null
  function saveWeekly(on) {
    setWeekly({ on, busy: true, error: '' })
    api.saveWeekly(on).then(() => setWeekly({ on, busy: false, error: '' }), () => setWeekly({ on: !on, busy: false, error: 'Could not save. Please try again.' }))
  }
  const weeklySwitch = <label className="admin-field admin-field--switch busy-weekly"><span><input type="checkbox" role="switch" checked={weekly.on} disabled={weekly.busy} onChange={event => saveWeekly(event.target.checked)} /> Send me "Your week" on Telegram every Monday</span>
    <span className="admin-detail-hint">One short message at about 8:00 on Mondays, to the same Telegram as your booking alerts: how full the last 4 weeks were, your next quiet day and who usually books then, times wanted when full, and a bank holiday coming up.</span>
    {weekly.error && <span className="admin-field-error" role="alert">{weekly.error}</span>}
  </label>
  if (!summary.count) return <section className="busy" aria-labelledby="busy-title">
    <h2 id="busy-title" className="admin-income-subhead">Busiest times</h2>
    <p className="admin-detail-hint">Your best days and times show here after your first appointments.</p>
  </section>
  const tip = quietDayTip(summary)
  const want = wantedTip(summary)
  const days = ranked(summary.days, 'bookings')
  const parts = ranked(summary.parts, 'bookings')
  const months = ranked(summary.months, 'bookings')
  const best = days.busy[0], quiet = days.busy.find(row => row.quietest)
  const holidays = summary.holidays
  const choices = summary.hasFull ? [['bookings', 'Bookings'], ['gbp', 'Income'], ['full', 'How full']] : [['bookings', 'Bookings'], ['gbp', 'Income']]
  // How full is only known by day of the week; the other views fall back to bookings.
  const order = view === 'days' && choices.some(([key]) => key === by) ? by : by === 'gbp' ? 'gbp' : 'bookings'
  return <section className="busy" aria-labelledby="busy-title">
    <h2 id="busy-title" className="admin-income-subhead">Busiest times</h2>
    <p className="busy-sub">All {plural(summary.count, 'visit')} since {monthYear(summary.since)}</p>
    {!summary.enough && <p className="busy-thin">Early days: rankings get useful after a few weeks of bookings.</p>}
    {summary.enough && <dl className="admin-income-facts busy-facts">
      <div><dt>Best day</dt><dd>{DAYS[best.index]}</dd><dd className="busy-fact-note">{rowMeta(best)}</dd></div>
      <div><dt>Quietest day</dt><dd>{quiet ? DAYS[quiet.index] : '–'}</dd>{quiet && <dd className="busy-fact-note">{rowMeta(quiet)}</dd>}</div>
      <div><dt>Busiest time</dt><dd>{PARTS[parts.busy[0].index].name}</dd><dd className="busy-fact-note">Most popular start {String(summary.topHour).padStart(2, '0')}:00</dd></div>
      {summary.fullLast4 !== null && summary.fullLast4 !== undefined
        ? <div><dt>How full</dt><dd>{summary.fullLast4}%</dd><dd className="busy-fact-note">of your working hours booked, last 4 weeks</dd>
          <dd className="busy-meter" aria-hidden="true"><span style={{ '--share': summary.fullLast4 / 100 }} /></dd></div>
        : <div><dt>{summary.fullYear ? 'Best month' : 'Best month so far'}</dt><dd>{MONTHS[months.busy[0].index]}</dd><dd className="busy-fact-note">{rowMeta(months.busy[0])}</dd></div>}
    </dl>}
    {(tip || want || summary.upcoming) && <>
      <h3 className="admin-income-minor">Ideas for this week</h3>
      <ul role="list" className="busy-ideas">
        {tip && <li>
          <span className="busy-kicker">Quiet day</span>
          <p><strong>{shortDay(tip.date)}{tip.freeMinutes ? ` has ${freeWords(tip.freeMinutes)}.` : '.'}</strong> {tip.day} is your quietest day. Open it and tap a Free gap to send a special price offer.
            {tip.regulars.length > 0 && ` ${tip.regulars.length === 1 ? 'One regular usually books' : `${tip.regulars.length} regulars usually book`} on a ${tip.day} and ${tip.regulars.length === 1 ? 'is' : 'are'} due:`}</p>
          {tip.regulars.length > 0 && <ul role="list" className="busy-who">
            {tip.regulars.map(row => <li key={row.id}>
              <span><strong>{row.first_name || 'Client'}</strong><small>{row.overdue >= 7 ? `${Math.round(row.overdue / 7)} ${Math.round(row.overdue / 7) === 1 ? 'week' : 'weeks'} past their usual gap` : 'due about now'}</small></span>
              {whatsappNumber(row.phone) && <a className="client-stat-message" href={`https://wa.me/${whatsappNumber(row.phone)}`} target="_blank" rel="noopener noreferrer">Message</a>}
            </li>)}
          </ul>}
          <button type="button" className="btn--tonal btn--small" onClick={() => openDay(tip.date)}>Open {shortDay(tip.date)}</button>
        </li>}
        {want && <li>
          <span className="busy-kicker">Wanted when full</span>
          <p><strong>{want.count} people wanted a {want.day} {want.part.name.toLowerCase()} that was full</strong> in the last 90 days (from Visitors). More {want.day} {want.part.plural} could turn them into bookings.</p>
          <button type="button" className="btn--tonal btn--small" onClick={() => (openHours || openDay)(want.date)}>{openHours ? 'Edit hours for' : 'Open'} {shortDay(want.date)}</button>
        </li>}
        {summary.upcoming && <li>
          <span className="busy-kicker">Bank holiday</span>
          <p><strong>{summary.upcoming.name} is {summary.upcoming.inDays === 0 ? 'today' : summary.upcoming.inDays === 1 ? 'tomorrow' : `in ${summary.upcoming.inDays} days`}</strong> ({shortDay(summary.upcoming.date)}).{' '}
            {holidays.past.length < 2 ? 'Decide whether you are working, and set the day off if not.'
              : holidays.overall === 'busier' ? 'Bank holidays have been busier than normal for you, so it may be worth working.'
              : holidays.overall === 'quieter' ? 'Bank holidays have been quieter than normal for you, so it could be a good day off.'
                : 'Decide whether you are working, and set the day off if not.'}</p>
          <button type="button" className="btn--tonal btn--small" onClick={() => openDay(summary.upcoming.date)}>Open {shortDay(summary.upcoming.date)}</button>
        </li>}
      </ul>
    </>}
    <div className="busy-views" role="group" aria-label="Show">
      {VIEWS.map(([key, text]) => <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key)}>{text}</button>)}
    </div>
    {view !== 'hols' && <div className="admin-income-yeartype" role="group" aria-label="Rank by">
      {choices.filter(([key]) => key !== 'full' || view === 'days').map(([key, text]) => <button key={key} type="button" aria-pressed={order === key} onClick={() => setBy(key)}>{text}</button>)}
    </div>}
    <div className="busy-card" aria-live="polite">
      <p className="busy-headline">{headline(view, summary, order)}</p>
      {view === 'days' && <>
        <Ranking rows={summary.days} by={order} name={row => DAYS[row.index].slice(0, 3)} full={row => DAYS[row.index]} extra={fullWords} emptyNote="No bookings yet on" wanted={summary.wanted.days} />
        {summary.hasFull && <p className="admin-detail-hint">How full: booked time (treatment and the travel before it) out of the working hours set for each day.</p>}
      </>}
      {view === 'times' && <>
        <Ranking rows={summary.parts} by={order} name={row => PARTS[row.index].name} full={row => PARTS[row.index].name} note={row => PARTS[row.index].hours} wanted={summary.wanted.parts} />
        <WeekGrid cells={summary.grid} wanted={summary.wanted.cells} />
      </>}
      {view === 'months' && <>
        <Ranking rows={summary.months} by={order} name={row => MONTHS[row.index].slice(0, 3)} full={row => MONTHS[row.index]} soFar />
        {!summary.fullYear && <p className="busy-thin">Only {plural(summary.monthsWithData, 'month')} of bookings so far. The month ranking gets reliable after a full year.</p>}
      </>}
      {view === 'hols' && <Holidays holidays={holidays} upcoming={summary.upcoming} />}
    </div>
    {weeklySwitch}
  </section>
}

function Ranking({ rows, by, name, full, note, extra, soFar, emptyNote, wanted }) {
  const { busy, empty, top } = ranked(rows, by)
  const value = row => by === 'gbp' ? row.gbp : by === 'full' ? (row.full ?? 0) : row.bookings
  return <>
    <ol className="busy-rank">
      {busy.map((row, position) => <li key={row.index} className={row.best ? 'is-best' : row.quietest ? 'is-quiet' : ''}
        aria-label={`${position + 1}. ${full(row)}: ${rowMeta(row)}${extra ? extra(row) : ''}${row.best ? ', best' : row.quietest ? ', quietest' : ''}`}>
        <span className="busy-rank-pos" aria-hidden="true">{position + 1}</span>
        <span className="busy-rank-name" aria-hidden="true">{name(row)}</span>
        <span className="busy-rank-bar" aria-hidden="true">
          <span className="busy-bar" style={{ '--share': top > 0 ? value(row) / top : 0 }} />
          <span className="busy-rank-meta">{note ? `${note(row)} · ` : ''}{rowMeta(row)}{extra ? extra(row) : ''}
            {row.best && <span className="busy-tag is-best">Best</span>}
            {row.quietest && <span className="busy-tag is-quiet">Quietest</span>}
            {soFar && row.soFar && <span className="busy-tag is-sofar">So far</span>}
            {wanted?.[row.index] > 0 && <span className="busy-wanted"> · {wantedWords(wanted[row.index])}</span>}
          </span>
        </span>
      </li>)}
    </ol>
    {empty.length > 0 && empty.length < rows.length && <p className="admin-detail-hint">{emptyNote || 'No bookings yet in'} {empty.map(full).join(', ')}.</p>}
  </>
}

// Mornings, afternoons and evenings across the week. Darker means more visits; an orange edge means people wanted that time when it was full.
function WeekGrid({ cells, wanted }) {
  const most = Math.max(1, ...cells.flat())
  const level = count => count === 0 ? '' : count / most > 0.66 ? ' is-3' : count / most > 0.33 ? ' is-2' : ' is-1'
  return <figure className="busy-grid">
    <table>
      <caption>Visits by day and time of day</caption>
      <thead><tr><td />{DAYS.map(day => <th key={day} scope="col" abbr={day}>{day[0]}</th>)}</tr></thead>
      <tbody>{PARTS.map((part, row) => <tr key={part.key}>
        <th scope="row">{part.name}</th>
        {DAYS.map((day, column) => <td key={day}>
          <span className={`busy-cell${level(cells[row][column])}${wanted?.[row]?.[column] ? ' is-wanted' : ''}`}
            aria-label={`${day} ${part.name.toLowerCase()}: ${plural(cells[row][column], 'visit')}${wanted?.[row]?.[column] ? `, ${wantedWords(wanted[row][column])}` : ''}`}>{cells[row][column] || ''}</span>
        </td>)}
      </tr>)}</tbody>
    </table>
    {wanted?.some(row => row.some(Boolean)) && <figcaption className="admin-detail-hint">An orange edge: people wanted that time when it was full (last 90 days).</figcaption>}
  </figure>
}

function Holidays({ holidays, upcoming }) {
  return <>
    {holidays.past.length > 0 && <ul role="list" className="busy-hols">
      {holidays.past.slice(0, 8).map(item => {
        const top = Math.max(item.bookings, item.usual, 0.01)
        return <li key={item.date}>
          <p className="busy-hol-name"><strong>{item.name}</strong><span>{shortDay(item.date)}</span></p>
          <div className="busy-compare">
            <span>That day</span>
            <span className="busy-rank-bar"><span className="busy-bar is-strong" style={{ '--share': item.bookings / top }} /><span className="busy-rank-meta">{plural(item.bookings, 'booking')} · {pounds(item.gbp)}</span></span>
            <span>A normal {DAYS[weekday(item.date)].slice(0, 3)}</span>
            <span className="busy-rank-bar"><span className="busy-bar" style={{ '--share': item.usual / top }} /><span className="busy-rank-meta">{usualWords(item.usual)} · {pounds(item.usualGbp)}</span></span>
          </div>
          <p className={`busy-verdict is-${item.verdict}`}>{verdictWords(item)}</p>
        </li>
      })}
    </ul>}
    {upcoming && <p className="admin-detail-hint"><strong>Coming up:</strong> {upcoming.name}, {shortDay(upcoming.date)}.</p>}
    {holidays.past.length < 4 && <p className="busy-thin">{holidays.past.length === 0 ? 'No bank holidays since your first booking yet.' : `Only ${plural(holidays.past.length, 'bank holiday')} so far.`} This gets more useful as the year goes on.</p>}
    <p className="admin-detail-hint">Bank holidays in England and Wales. A normal day is the average of the same weekday on other weeks.</p>
  </>
}
