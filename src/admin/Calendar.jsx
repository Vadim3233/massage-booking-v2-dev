import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { createCalendarApi } from './calendarApi.js'
import { clientName, dayContext, expired, label, money, shiftDate, time, today } from './calendarPresentation.js'
import BookingDetails from './BookingDetails.jsx'
const api = createCalendarApi(supabase)
// One owner for all Calendar reads, including StrictMode's repeated mount effect.
let inFlight
function load(date) {
  if (inFlight?.date === date) return inFlight.promise
  const promise = api.loadCalendarRange(date, shiftDate(date, 1)).finally(() => { if (inFlight?.promise === promise) inFlight = null })
  inFlight = { date, promise }; return promise
}
export default function Calendar({ signOut }) {
  const [date, setDate] = useState(today)
  const [result, setResult] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState(null)
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    let live = true
    load(date).then(data => { if (live) setResult({ date, attempt, data }) }, error => { if (live) setResult({ date, attempt, error: error.message }) })
    return () => { live = false }
  }, [date, attempt])
  const current = result?.date === date && result?.attempt === attempt ? result : null
  const data = current?.data
  const context = data && dayContext(data, date, now)
  const booking = data?.bookings.find(row => row.id === selected)
  function navigate(value) { if (!value) return; setSelected(null); setDate(value) }
  return <>
    <header className="admin-header"><div><strong>VadMassage · Calendar</strong><button onClick={signOut}>Sign out</button></div><nav aria-label="Calendar navigation"><button aria-label="Previous day" onClick={() => navigate(shiftDate(date, -1))}>‹</button><input aria-label="Calendar date" type="date" value={date} onChange={event => navigate(event.target.value)} /><button aria-label="Next day" onClick={() => navigate(shiftDate(date, 1))}>›</button><button aria-label="Today" title="Today" onClick={() => navigate(today())}>●</button><button aria-label="Refresh calendar" onClick={() => setAttempt(value => value + 1)}>↻</button></nav></header>
    <section className="admin-day" aria-label="Day appointments"><h1>{date}</h1><small>London time · Read only</small>
      {!current && <p role="status">Loading calendar…</p>}
      {current?.error && <><p role="alert">Could not load calendar: {current.error}</p><button onClick={() => setAttempt(value => value + 1)}>Retry calendar</button></>}
      {data && <><p>{context.hours?.available ? `Working hours ${time(context.hours.start_minutes)}–${time(context.hours.end_minutes)}` : 'Not a working day'}</p>
        {!data.bookings.length && <p>No appointments for this day.</p>}
        {data.bookings.map(b => <button className={`admin-card ${b.booking_status === 'cancelled' ? 'cancelled' : ''}`} key={b.id} onClick={() => setSelected(b.id)}><strong>{time(b.start_minutes)} · {clientName(b)}</strong><span>{b.booking_sessions.map(s => `${s.service_name_snapshot} · ${s.duration_minutes} min`).join('; ')}</span><span>{expired(b, now) ? 'Transfer reservation expired' : label(b.booking_status)} · {label(b.booking_payments?.status)}</span><span>{b.postcode_snapshot} · {money(b.total_gbp)}</span></button>)}
        <h2>Day context</h2>{data.blocks.map(b => <p key={b.id}>{time(b.start_minutes)}–{time(b.end_minutes)} · {b.title || 'Blocked time'}</p>)}
        {context.holds.map(h => <p key={h.id}>{time(h.start_minutes)}–{time(h.start_minutes + h.treatment_duration_minutes)} · Active hold</p>)}
        <h3>Unoccupied intervals</h3><small>Includes travel buffers. These are not bookable-slot suggestions.</small>{context.gaps.length ? context.gaps.map(([start, end]) => <p key={start}>{time(start)}–{time(end)}</p>) : <p>No unoccupied working intervals.</p>}
      </>}
    </section>{booking && <BookingDetails booking={booking} now={now} close={() => setSelected(null)} />}
  </>
}
