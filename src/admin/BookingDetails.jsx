import { useEffect, useRef } from 'react'
import { clientName, expired, label, money, postcode, time } from './calendarPresentation.js'
export default function BookingDetails({ booking: b, close, now }) {
  const ref = useRef(null)
  useEffect(() => { const dialog = ref.current; dialog.showModal(); return () => dialog.close() }, [])
  const stamp = value => value ? new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/London' }) : 'Not recorded'
  return <dialog className="admin-details" ref={ref} onCancel={close} aria-labelledby="booking-title">
    <button onClick={close}>Close details</button><h2 id="booking-title">{b.booking_reference}</h2>
    <p>{b.date} · {time(b.start_minutes)} · {b.treatment_duration_minutes} minutes</p>
    <p>{expired(b, now) ? 'Transfer reservation expired' : label(b.booking_status)}</p>
    <p>Payment: {label(b.booking_payments?.method)} · {label(b.booking_payments?.status)}</p>
    <h3>Client</h3><p>{clientName(b)}<br />{b.booking_email_snapshot || b.clients?.email}<br />{b.clients?.phone}</p>
    <h3>Visit address</h3><p>{[b.address_line_1_snapshot, b.address_line_2_snapshot, b.city_snapshot, postcode(b.postcode_snapshot)].filter(Boolean).join(', ')}</p><p>{b.entry_instructions_snapshot}</p>
    <h3>Sessions</h3><ul>{[...b.booking_sessions].sort((a, b) => a.position - b.position).map(s => <li key={s.id}>{s.service_name_snapshot} · {s.duration_minutes} minutes · {money(s.unit_price_gbp)}{s.recipient_name && <p>{s.recipient_name}</p>}<ul>{s.booking_session_preferences.map(p => <li key={p.preference_id}>{p.preference_category_snapshot}: {p.preference_label_snapshot}</li>)}{s.booking_session_enhancements.map(e => <li key={e.id}>{e.enhancement_name_snapshot} × {e.quantity} · {money(e.unit_price_gbp)}</li>)}</ul></li>)}</ul>
    <h3>Appointment enhancements</h3>{b.booking_enhancements.length ? <ul>{b.booking_enhancements.map(e => <li key={e.id}>{e.enhancement_name_snapshot} × {e.quantity} · {money(e.unit_price_gbp)}</li>)}</ul> : <p>None</p>}
    <h3>Client note</h3><p>{b.client_note || 'None'}</p>
    <h3>Price</h3><dl>{[['Treatments', b.service_subtotal_gbp], ['Enhancements', b.enhancements_total_gbp], ['Travel', b.travel_fee_gbp], ['Congestion', b.congestion_fee_gbp], ['Total', b.total_gbp]].map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{money(value)}</dd></div>)}</dl>
    <p>Area: {b.service_area_name_snapshot}<br />Travel buffer: {b.travel_buffer_minutes} minutes<br />Source: {b.source_channel}</p>
    <p>Created: {stamp(b.created_at)}<br />Updated: {stamp(b.updated_at)}<br />Transfer deadline: {stamp(b.payment_reservation_expires_at)}<br />Transfer declared: {stamp(b.booking_payments?.transfer_declared_at)}<br />Verified: {stamp(b.booking_payments?.verified_at)}<br />Paid: {stamp(b.booking_payments?.paid_at)}</p>
    {b.cancelled_at && <p>Cancelled: {stamp(b.cancelled_at)}<br />Cancelled by: {label(b.cancelled_by_actor_type)} · {b.cancelled_by_actor_id || 'Not recorded'}</p>}
  </dialog>
}
