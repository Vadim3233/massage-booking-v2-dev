import { useEffect, useRef, useState } from 'react'
import { clientName, dateLabel, money, time } from './calendarPresentation.js'
import { acquireBodyScrollLock } from './dialogScrollLock.js'
import { MAX_EXTRA, PAY_LABELS, STEPS, extendApi, minutesWords, newEnd, nextClash, runningLateLink, suggestedPrice } from './extendApi.js'
import Icon from '../ui/icons.jsx'

// "Add extra time": the client stayed longer. Pick how much (and who, for a couple), check the price (the extra-time rate pro rata, which he can
// change), and how it is paid. A paid booking's extra can be cash there and then, or asked for by bank transfer (the client is emailed the bill with
// the bank details); an unpaid booking's extra goes on the bill. Running into the next booking is said, with a "running late" WhatsApp, but never stops it.
export default function ExtendDialog({ booking, close, done, api = extendApi }) {
  const ref = useRef(null)
  const request = useRef(null)
  const [preview, setPreview] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [sessionId, setSessionId] = useState(null)
  const [chosen, setMinutes] = useState(30)
  // The price he typed, or null while it follows the suggested one (the time and the person).
  const [typed, setTyped] = useState(null)
  const [payBy, setPayBy] = useState(null)
  const [notify, setNotify] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const dialog = ref.current
    const opener = document.activeElement
    dialog.showModal()
    const release = acquireBodyScrollLock()
    return () => { if (dialog.open) dialog.close(); release(); opener?.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => {
    let live = true
    api.preview(booking.id).then(value => {
      if (!live) return
      setPreview(value)
      setSessionId(value.sessions?.[0]?.id || null)
      setPayBy(value.pay_by?.[0] || null)
      setLoadError('')
    }, failure => { if (live) setLoadError(failure.message) })
    return () => { live = false }
  }, [api, booking.id])

  const sessions = preview?.sessions || []
  const session = sessions.find(item => item.id === sessionId) || sessions[0]
  const left = MAX_EXTRA - Number(preview?.extended_minutes || 0)
  const steps = STEPS.filter(step => step <= left)
  // 30 minutes to start with, or the most that is still allowed.
  const minutes = steps.includes(chosen) ? chosen : steps.filter(step => step < chosen).at(-1) ?? steps[0] ?? 0
  const suggested = suggestedPrice(session?.hour_price, minutes)
  const price = typed ?? String(suggested)
  const amount = payBy === 'free' ? 0 : Number(price)
  const priceValid = payBy === 'free' || (price !== '' && Number.isFinite(amount) && amount >= 0 && amount <= 1000)
  const clash = nextClash(preview, minutes)
  const lateLink = clash?.clash ? runningLateLink(clash.next, clash.late) : null
  const first = booking.clients?.first_name?.trim() || 'The client'
  const email = booking.booking_email_snapshot || booking.clients?.email
  const ready = Boolean(preview && !preview.refusal && session && payBy && steps.includes(minutes) && priceValid)

  async function submit(event) {
    event.preventDefault()
    if (busy || !ready) return
    setBusy(true); setError('')
    const payload = { sessionId: session.id, minutes, price: amount, payBy, notify: payBy === 'transfer' || notify }
    const key = JSON.stringify([booking.updated_at, payload])
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    try {
      await api.extend(booking, request.current.id, payload)
      await done(`Added ${minutesWords(minutes)} extra time.`)
    } catch (failure) {
      setError(failure.message)
      if (failure.conflict) await done(failure.message, true)
    } finally { setBusy(false) }
  }

  const hourWords = session ? `${money(session.hour_price)} an hour${preview?.rate ? '' : `, your ${session.service_name} 1-hour price`}` : ''
  return <dialog ref={ref} className="admin-confirm admin-action admin-extend" aria-labelledby="extend-title" onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) close() }}>
    <form onSubmit={submit}>
      <h2 id="extend-title">Add extra time</h2>
      <div className="admin-confirm-summary"><strong>{clientName(booking)}</strong><span>{dateLabel(booking.date)} · {time(booking.start_minutes)}</span><b className="figure">{money(booking.total_gbp)}</b></div>
      {loadError && <p role="alert">{loadError}</p>}
      {!preview && !loadError && <p role="status">Loading…</p>}
      {preview?.refusal && <p role="alert">{preview.refusal}</p>}
      {preview && !preview.refusal && <>
        {sessions.length > 1 && <fieldset className="admin-who admin-fee-choices" style={{ '--choices': Math.min(sessions.length, 2) }}><legend>Who stayed longer?</legend>
          {sessions.map((item, index) => <label key={item.id}><input type="radio" name="extend-who" checked={session?.id === item.id} disabled={busy} onChange={() => { setSessionId(item.id); setTyped(null) }} /> {item.recipient_name || `Person ${index + 1}`} · {item.service_name}</label>)}
        </fieldset>}
        {steps.length === 0 ? <p role="status">This booking already has {minutesWords(MAX_EXTRA)} of extra time, the most it can have.</p> : <>
          <fieldset className="admin-who admin-fee-choices" style={{ '--choices': Math.min(steps.length, 3) }}><legend>How much longer?</legend>
            {steps.map(step => <label key={step}><input type="radio" name="extend-minutes" checked={minutes === step} disabled={busy} onChange={() => { setMinutes(step); setTyped(null) }} /> +{step}</label>)}
          </fieldset>
          <p className="admin-extend-ends" role="status"><span>Now ends</span><b>{time(Number(preview.end_minutes))} → {newEnd(preview, minutes)}</b></p>
          {clash && (clash.clash
            ? <div className="admin-extend-warn" role="status"><p>This runs into your next booking: {clash.next.first_name || 'a client'} at {time(clash.next.start_minutes)}{clash.travel ? `, with ${clash.travel} min to get there` : ''}. It will still be saved.</p>
              {lateLink && <a className="btn btn--tonal btn--small" href={lateLink} target="_blank" rel="noopener noreferrer"><Icon name="chat" size={16} />Tell {clash.next.first_name || 'them'} you're running late</a>}</div>
            : <p className="admin-detail-hint">Your next booking is {clash.next.first_name || 'a client'} at {time(clash.next.start_minutes)}. You can leave at {newEnd(preview, minutes)}, so that's fine.</p>)}

          <fieldset className="admin-extend-pay"><legend>How they pay the extra</legend>
            {(preview.pay_by || []).map(choice => <label key={choice} className="admin-who-row"><input type="radio" name="extend-pay" checked={payBy === choice} disabled={busy} onChange={() => setPayBy(choice)} /> {PAY_LABELS[choice]}</label>)}
          </fieldset>
          {payBy !== 'free' && <label className="admin-field">Price for the extra {minutesWords(minutes)} (£)
            <input type="number" inputMode="decimal" min="0" max="1000" step="1" value={price} disabled={busy} onChange={event => setTyped(event.target.value)} />
            <span className="admin-detail-hint">Suggested {money(suggested)}: {hourWords}, for {minutesWords(minutes)}.</span>
            {typed !== null && Number(typed) !== suggested && <button type="button" className="btn--quiet btn--small" onClick={() => setTyped(null)}>Use {money(suggested)}</button>}
          </label>}
          {payBy === 'bill' && <p className="admin-detail-hint">It goes on what they still have to pay: {money(Number(booking.booking_payments?.amount_gbp || 0) + (priceValid ? amount : 0))} in all.</p>}
          {payBy === 'transfer' ? <p className="admin-detail-hint">{email ? `${first} gets an email with the bill and your bank details. You can also share it on WhatsApp from the booking.` : `${first} has no email on this booking. Share the request on WhatsApp from the booking.`}</p>
            : email && <label className="admin-who-row"><input type="checkbox" checked={notify} disabled={busy} onChange={event => setNotify(event.target.checked)} /> Send {first} a thank-you with the updated bill</label>}
        </>}
      </>}
      {error && <p role="alert">{error}</p>}
      <div className="admin-payment-buttons admin-sticky-actions">
        <button type="submit" className="btn--primary" disabled={busy || !ready}>{busy ? 'Saving…' : `Add ${minutesWords(minutes)} · ${payBy === 'free' || amount === 0 ? 'no charge' : money(amount)}`}</button>
        <button type="button" className="btn--quiet" disabled={busy} onClick={close}>Go back</button>
      </div>
    </form>
  </dialog>
}
