import { useEffect, useState } from 'react'
import { DAYS, ENOUGH_CLIENT_VISITS, PARTS, clientTimes, nextWeekday, plural, shortDay } from './busyTimes.js'

// A client's card › When … books (ADR-101): their usual day and time of day, from their visits. With a usual day and nothing booked, one tap
// starts a new booking for them on the next one. Hidden if the database change is not applied yet.
export default function ClientTimes({ client, api, version, nextDate, newBooking }) {
  const [data, setData] = useState(null)
  useEffect(() => {
    let live = true
    if (!api.times) return undefined
    api.times(client.id).then(value => { if (live) setData(value) }, () => { if (live) setData(false) })
    return () => { live = false }
  }, [api, client.id, version])
  if (!data) return null
  const times = clientTimes(data.visits, data.today)
  if (!times.count) return null
  const name = client.first_name || 'this client'
  const most = Math.max(...times.days)
  const partMost = Math.max(...times.parts)
  const full = times.count >= ENOUGH_CLIENT_VISITS
  const usualDate = full && times.usualDay != null && !nextDate && newBooking ? nextWeekday(data.today, times.usualDay) : null
  return <section className="client-times" aria-labelledby="client-times-title">
    <h3 id="client-times-title" className="client-times-title">When {name} books</h3>
    <p className="client-times-sentence">{times.sentence}{times.months && ` Comes most in ${times.months}.`}</p>
    {full ? <>
      <ol role="list" className="client-times-days">
        {times.days.map((count, index) => <li key={DAYS[index]} aria-label={`${DAYS[index]}: ${plural(count, 'visit')}`}>
          <span className={`client-times-dot${count === 0 ? '' : count === most ? ' is-most' : ' is-some'}`} aria-hidden="true">{count || ''}</span>
          <span aria-hidden="true">{DAYS[index][0]}</span>
        </li>)}
      </ol>
      <ul role="list" className="client-times-parts">
        {times.parts.map((count, index) => <li key={PARTS[index].key} className={count === 0 ? '' : count === partMost ? 'is-most' : 'is-some'}>
          <strong>{count}</strong>{PARTS[index].name}
        </li>)}
      </ul>
      {usualDate && <button type="button" className="btn--tonal btn--small client-times-book" onClick={() => newBooking(client.id, usualDate)}>Book their usual: {shortDay(usualDate)}</button>}
      <p className="client-times-note">From {plural(times.count, 'visit')}. Morning is before 12:00, evening from 17:00.</p>
    </> : <p className="client-times-note">A full picture shows after {ENOUGH_CLIENT_VISITS} visits.</p>}
  </section>
}
