import { useEffect, useState } from 'react'
import { whatsappNumber } from './contactLinks.js'
import { ClientTag } from './Clients.jsx'
import { agoWords, daysBetween, gapWords, monthYear, overdueWeeks, shortDate } from './clientStats.js'

const monthLetter = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'narrow' })
const monthName = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long' })

// A client's rhythm on their card (ADR-099): their tag, a note when they have gone quiet, how often they come, and their visits month by month.
// If the stats cannot be read (for example before the database change is applied) nothing shows and the card works as before.
export default function ClientRhythm({ client, api, version }) {
  const [rhythm, setRhythm] = useState(null)
  useEffect(() => {
    let live = true
    if (!api.rhythm) return undefined
    api.rhythm(client.id).then(value => { if (live) setRhythm(value) }, () => { if (live) setRhythm(false) })
    return () => { live = false }
  }, [api, client.id, version])
  if (!rhythm) return null
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
  const most = Math.max(1, ...rhythm.months.map(month => month.visits))
  const year = rhythm.months.reduce((sum, month) => sum + month.visits, 0)
  const number = whatsappNumber(client.phone)
  const name = client.first_name || 'This client'
  return <section className="client-rhythm" aria-label="How often they come">
    {rhythm.tag && <p className="client-rhythm-tag"><ClientTag tag={rhythm.tag} />{rhythm.first_visit && <span>Client since {monthYear(rhythm.first_visit)}</span>}</p>}
    {rhythm.tag === 'quiet' && <div className="client-stat-card client-stat-card--quiet client-rhythm-quiet" role="status">
      <p><strong>About {overdueWeeks(rhythm.overdue_days)} {overdueWeeks(rhythm.overdue_days) === 1 ? 'week' : 'weeks'} overdue.</strong> {name} usually books {gapWords(rhythm.gap_days)}, and the last visit was {shortDate(rhythm.last_visit)}.</p>
      {number && <a className="client-stat-message" href={`https://wa.me/${number}`} target="_blank" rel="noopener noreferrer">Send a message</a>}
    </div>}
    {rhythm.visits > 0 && <dl className="admin-client-summary client-rhythm-figures">
      <div><dt>Usual gap</dt><dd>{rhythm.visits >= 2 && rhythm.gap_days != null ? gapWords(rhythm.gap_days).replace('every ', '') : '–'}</dd></div>
      <div><dt>Since last visit</dt><dd>{agoWords(daysBetween(rhythm.last_visit, today))}</dd></div>
      <div><dt>Rank by visits</dt><dd>{rhythm.rank} of {rhythm.clients}</dd></div>
      <div><dt>Last 12 months</dt><dd>{year} {year === 1 ? 'visit' : 'visits'}</dd></div>
    </dl>}
    {rhythm.visits > 0 && <figure className="client-rhythm-months">
      <figcaption>Visits, last 12 months</figcaption>
      <ol role="list">{rhythm.months.map(month => <li key={month.month} aria-label={`${monthName(month.month)}: ${month.visits} ${month.visits === 1 ? 'visit' : 'visits'}`}>
        <span className={`client-rhythm-bar${month.visits ? '' : ' is-empty'}`} style={{ '--share': month.visits / most }} aria-hidden="true" />
        <span aria-hidden="true">{monthLetter(month.month)}</span>
      </li>)}</ol>
    </figure>}
  </section>
}
