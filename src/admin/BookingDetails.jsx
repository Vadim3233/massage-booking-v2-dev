import { useEffect, useRef } from 'react'
import { bookingState, clientName, dateLabel, label, money, postcode, time } from './calendarPresentation.js'
import { acquireBodyScrollLock } from './dialogScrollLock.js'
import { contactLinks } from './contactLinks.js'
export default function BookingDetails({ booking: b, close, now, payment, lifecycle, returnFocus }) {
  const ref = useRef(null)
  useEffect(() => {
    const dialog = ref.current
    const opener = returnFocus || document.activeElement
    dialog.showModal()
    const releaseScrollLock = acquireBodyScrollLock()
    return () => {
      if (dialog.open) dialog.close()
      releaseScrollLock()
      opener?.focus({ preventScroll: true })
    }
  }, [returnFocus])
  const stamp = value => value ? new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/London' }) : 'Not recorded'
  const state = bookingState(b, now)
  const email = b.booking_email_snapshot || b.clients?.email
  return <dialog className="admin-details" ref={ref} onCancel={close} aria-labelledby="booking-title">
    <header className="admin-details-bar"><button onClick={close} aria-label="Close details"><span aria-hidden="true">‹</span> Back</button><div><strong>{dateLabel(b.date)}</strong><span>{time(b.start_minutes)}–{time(b.start_minutes + b.treatment_duration_minutes)}</span></div></header>
    <div className="admin-details-content">
      <section className="admin-details-client"><h2 id="booking-title">{clientName(b)}</h2><p className={`admin-status ${state.tone}`}>{state.text}</p><p>Payment: {label(b.booking_payments?.method)} · {label(b.booking_payments?.status)}</p>
        <nav className="admin-contact-actions" aria-label="Quick contact">{contactLinks(b).map(link => <a key={link.key} href={link.href} {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{link.label}</a>)}</nav></section>
      {payment && <section><h3>Payment</h3>{payment}</section>}
      {lifecycle && <section><h3>Appointment</h3>{lifecycle}</section>}
      <section><h3>Contact</h3><p>{email ? <a href={`mailto:${email}`}>{email}</a> : 'Email not recorded'}</p><p>{b.clients?.phone ? <a href={`tel:${b.clients.phone}`}>{b.clients.phone}</a> : 'Phone not recorded'}</p></section>
      <section><h3>Address</h3><address>{[b.address_line_1_snapshot, b.address_line_2_snapshot, b.city_snapshot, postcode(b.postcode_snapshot)].filter(Boolean).map((line, index) => <div key={index}>{line}</div>)}</address>{b.entry_instructions_snapshot && <p>{b.entry_instructions_snapshot}</p>}</section>
      <section><h3>Sessions</h3><ol className="admin-session-list">{[...b.booking_sessions].sort((a, b) => a.position - b.position).map((s, index) => <li key={s.id}>
        <h4>{b.booking_sessions.length > 1 ? `Session ${index + 1}` : s.service_name_snapshot}{s.recipient_name && ` · ${s.recipient_name}`}</h4><p>{b.booking_sessions.length > 1 && `${s.service_name_snapshot} · `}{s.duration_minutes} minutes · {money(s.unit_price_gbp)}</p>
        {s.booking_session_preferences.length > 0 && <><h5>Preferences</h5><ul>{s.booking_session_preferences.map(p => <li key={p.preference_id}>{p.preference_category_snapshot}: {p.preference_label_snapshot}</li>)}</ul></>}
        {s.booking_session_enhancements.length > 0 && <><h5>Session enhancements</h5><ul>{s.booking_session_enhancements.map(e => <li key={e.id}>{e.enhancement_name_snapshot} × {e.quantity} · {money(e.unit_price_gbp)}</li>)}</ul></>}
      </li>)}</ol></section>
      <section><h3>Appointment enhancements</h3>{b.booking_enhancements.length ? <ul>{b.booking_enhancements.map(e => <li key={e.id}>{e.enhancement_name_snapshot} × {e.quantity} · {money(e.unit_price_gbp)}</li>)}</ul> : <p>None</p>}</section>
      <section><h3>Client note</h3><p>{b.client_note || 'None'}</p></section>
      <section><h3>Price breakdown</h3><dl className="admin-price-breakdown">{[['Treatments', b.service_subtotal_gbp], ['Enhancements', b.enhancements_total_gbp], ['Travel', b.travel_fee_gbp], ['Congestion', b.congestion_fee_gbp], ['Total', b.total_gbp]].map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{money(value)}</dd></div>)}</dl></section>
      <section><h3>Travel / area</h3><p>{b.service_area_name_snapshot || 'Area not recorded'}</p><p>Travel / buffer: {b.travel_buffer_minutes} minutes</p><p className="admin-detail-hint">Scheduling allowance, not measured travel time.</p></section>
      <section className="admin-metadata"><h3>Booking metadata</h3><dl>{[['Reference', b.booking_reference], ['Booking date', b.date], ['Duration', `${b.treatment_duration_minutes} minutes`], ['Source', b.source_channel], ['Created', stamp(b.created_at)], ['Updated', stamp(b.updated_at)], ['Transfer declared', stamp(b.booking_payments?.transfer_declared_at)], ['Verified', stamp(b.booking_payments?.verified_at)], ['Paid', stamp(b.booking_payments?.paid_at)]].map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl></section>
      {b.cancelled_at && <section className="admin-metadata"><h3>Cancellation</h3><p>Cancelled: {stamp(b.cancelled_at)}</p><p>Cancelled by: {label(b.cancelled_by_actor_type)} · {b.cancelled_by_actor_id || 'Not recorded'}</p>{b.cancellation_initiated_by && <p>Requested by: {label(b.cancellation_initiated_by)}</p>}{b.cancellation_reason && <p>Reason: {b.cancellation_reason}</p>}</section>}
    </div>
  </dialog>
}
