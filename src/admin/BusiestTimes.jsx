import { useEffect, useMemo, useState } from 'react'
import { DAYS, MONTHS, PARTS, busySummary, headline, plural, pounds, quietDayTip, ranked, rowMeta, shortDay, usualWords, verdictWords, wantedTip, wantedWords, weekday } from './busyTimes.js'

const VIEWS = [['days', 'Days'], ['times', 'Times'], ['months', 'Months'], ['hols', 'Holidays']]
const monthYear = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'short', year: 'numeric' })

// Income › Busiest times (ADR-101): every visit since the first one, whatever period the page above shows. Four answers at a glance, ideas
// to act on (a quiet day to fill with a special price offer, times people wanted when they were full, a bank holiday coming up), then a
// ranking for each question.
// If the database change is not applied yet, the section stays hidden and the page works as before.
export default function BusiestTimes({ api, openDay }) {
  const [data, setData] = useState(null)
  const [view, setView] = useState('days')
  const [by, setBy] = useState('bookings')
  useEffect(() => {
    let live = true
    if (!api.busy) return undefined
    api.busy().then(value => { if (live) setData(value) }, () => { if (live) setData(false) })
    return () => { live = false }
  }, [api])
  const summary = useMemo(() => data ? busySummary(data) : null, [data])
  if (!summary) return null
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
  return <section className="busy" aria-labelledby="busy-title">
    <h2 id="busy-title" className="admin-income-subhead">Busiest times</h2>
    <p className="busy-sub">All {plural(summary.count, 'visit')} since {monthYear(summary.since)}</p>
    {!summary.enough && <p className="busy-thin">Early days: rankings get useful after a few weeks of bookings.</p>}
    {summary.enough && <dl className="admin-income-facts busy-facts">
      <div><dt>Best day</dt><dd>{DAYS[best.index]}</dd><dd className="busy-fact-note">{rowMeta(best)}</dd></div>
      <div><dt>Quietest day</dt><dd>{quiet ? DAYS[quiet.index] : '–'}</dd>{quiet && <dd className="busy-fact-note">{rowMeta(quiet)}</dd>}</div>
      <div><dt>Busiest time</dt><dd>{PARTS[parts.busy[0].index].name}</dd><dd className="busy-fact-note">{PARTS[parts.busy[0].index].hours}</dd></div>
      <div><dt>{summary.fullYear ? 'Best month' : 'Best month so far'}</dt><dd>{MONTHS[months.busy[0].index]}</dd><dd className="busy-fact-note">{rowMeta(months.busy[0])}</dd></div>
    </dl>}
    {(tip || want || summary.upcoming) && <ul role="list" className="busy-ideas">
      {want && <li>
        <p><strong>{want.count} people wanted a {want.day} {want.part.name.toLowerCase()} that was full</strong> (last 90 days, from Visitors). More {want.day} {want.part.plural} could turn them into bookings: open the day and tap Edit hours.</p>
        <button type="button" className="btn--tonal btn--small" onClick={() => openDay(want.date)}>Open {shortDay(want.date)}</button>
      </li>}
      {tip && <li>
        <p><strong>{tip.day} is your quietest day.</strong> A free gap on a {tip.day} is a good one for a special price offer: open the day and tap Free.</p>
        <button type="button" className="btn--tonal btn--small" onClick={() => openDay(tip.date)}>Open {shortDay(tip.date)}</button>
      </li>}
      {summary.upcoming && <li>
        <p><strong>{summary.upcoming.name} is {summary.upcoming.inDays === 0 ? 'today' : summary.upcoming.inDays === 1 ? 'tomorrow' : `in ${summary.upcoming.inDays} days`}</strong> ({shortDay(summary.upcoming.date)}).{' '}
          {holidays.overall === 'busier' ? 'Bank holidays have been busier than normal for you, so it may be worth working.'
            : holidays.overall === 'quieter' ? 'Bank holidays have been quieter than normal for you, so it could be a good day off.'
              : 'Decide whether you are working, and set the day off if not.'}</p>
        <button type="button" className="btn--tonal btn--small" onClick={() => openDay(summary.upcoming.date)}>Open {shortDay(summary.upcoming.date)}</button>
      </li>}
    </ul>}
    <div className="busy-views" role="group" aria-label="Show">
      {VIEWS.map(([key, text]) => <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key)}>{text}</button>)}
    </div>
    {view !== 'hols' && <div className="admin-income-yeartype" role="group" aria-label="Rank by">
      {[['bookings', 'By bookings'], ['gbp', 'By income']].map(([key, text]) => <button key={key} type="button" aria-pressed={by === key} onClick={() => setBy(key)}>{text}</button>)}
    </div>}
    <div className="busy-card" aria-live="polite">
      <p className="busy-headline">{headline(view, summary, by)}</p>
      {view === 'days' && <Ranking rows={summary.days} by={by} name={row => DAYS[row.index].slice(0, 3)} full={row => DAYS[row.index]} emptyNote="No bookings yet on" wanted={summary.wanted.days} />}
      {view === 'times' && <Ranking rows={summary.parts} by={by} name={row => PARTS[row.index].name} full={row => PARTS[row.index].name} note={row => PARTS[row.index].hours} wanted={summary.wanted.parts} />}
      {view === 'months' && <>
        <Ranking rows={summary.months} by={by} name={row => MONTHS[row.index].slice(0, 3)} full={row => MONTHS[row.index]} soFar />
        {!summary.fullYear && <p className="busy-thin">Only {plural(summary.monthsWithData, 'month')} of bookings so far. The month ranking gets reliable after a full year.</p>}
      </>}
      {view === 'hols' && <Holidays holidays={holidays} upcoming={summary.upcoming} />}
    </div>
  </section>
}

function Ranking({ rows, by, name, full, note, soFar, emptyNote, wanted }) {
  const { busy, empty, top } = ranked(rows, by)
  const value = row => by === 'gbp' ? row.gbp : row.bookings
  return <>
    <ol className="busy-rank">
      {busy.map((row, position) => <li key={row.index} className={row.best ? 'is-best' : row.quietest ? 'is-quiet' : ''}
        aria-label={`${position + 1}. ${full(row)}: ${rowMeta(row)}${row.best ? ', best' : row.quietest ? ', quietest' : ''}`}>
        <span className="busy-rank-pos" aria-hidden="true">{position + 1}</span>
        <span className="busy-rank-name" aria-hidden="true">{name(row)}</span>
        <span className="busy-rank-bar" aria-hidden="true">
          <span className="busy-bar" style={{ '--share': top > 0 ? value(row) / top : 0 }} />
          <span className="busy-rank-meta">{note ? `${note(row)} · ` : ''}{rowMeta(row)}
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
