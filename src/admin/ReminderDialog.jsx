import { useEffect, useRef } from 'react'
import { clientName, dateLabel, money, time } from './calendarPresentation.js'
import { acquireBodyScrollLock } from './dialogScrollLock.js'

// "Not yet": asks when to be reminded. It is a sheet like the payment confirmations, rising from the bottom on a phone. Choosing sets a reminder
// and nothing else; going back, or Escape, changes nothing.
export default function ReminderDialog({ booking, choices, cancel, choose }) {
  const ref = useRef(null)
  useEffect(() => {
    const opener = document.activeElement
    const dialog = ref.current
    dialog.showModal()
    const releaseScrollLock = acquireBodyScrollLock()
    return () => {
      if (dialog.open) dialog.close()
      releaseScrollLock()
      opener?.focus({ preventScroll: true })
    }
  }, [])
  const method = booking.booking_payments?.method === 'cash' ? 'Cash request' : 'Bank transfer'
  return <dialog ref={ref} className="admin-confirm" aria-labelledby="reminder-title" aria-describedby="reminder-what" onCancel={event => { event.preventDefault(); event.stopPropagation(); cancel() }}>
    <h2 id="reminder-title">Remind me later?</h2>
    <div className="admin-confirm-summary"><strong>{clientName(booking)}</strong><span>{dateLabel(booking.date)} · {time(booking.start_minutes)} · {method}</span><b className="figure">{money(booking.total_gbp)}</b></div>
    <p id="reminder-what">The booking keeps its time and the client is told nothing. This comes back into Needs you when you choose.</p>
    <div className="admin-payment-buttons">
      {choices.map(choice => <button key={choice.key} type="button" className="btn--tonal" onClick={() => choose(choice)}>{choice.label}</button>)}
      <button type="button" className="btn--quiet" onClick={cancel}>Go back</button>
    </div>
  </dialog>
}
