import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import Icon from '../ui/icons.jsx'
import { acquireBodyScrollLock } from './dialogScrollLock.js'
import { dateLabel, money, time, today } from './calendarPresentation.js'
import { closingChoices, createOfferApi, lengthsThatFit, londonClock, offerMessage, offerSummary, startsThatFit, whatsappOfferLink } from './slotOffers.js'

const defaultApi = createOfferApi(supabase)
const nowMinutes = () => { const [h, m] = londonClock(new Date()).split(':').map(Number); return h * 60 + m }

// Offer a free time at a special price (made from a free stretch of the day), or share, change or stop an offer already made.
// The price is all-in. Anyone with the link can book it; the first to book gets it.
export default function OfferDialog({ date, free, offer: existing, close, changed, api = defaultApi }) {
  const ref = useRef(null)
  const [offer, setOffer] = useState(existing || null)
  const [lengths, setLengths] = useState(null)
  const [minutes, setMinutes] = useState(null)
  const [start, setStart] = useState(null)
  const [price, setPrice] = useState(existing ? String(Number(existing.price_gbp)) : '')
  const [closing, setClosing] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [said, setSaid] = useState('')
  const [editing, setEditing] = useState(false)
  const [stopping, setStopping] = useState(false)

  useEffect(() => {
    const dialog = ref.current
    const opener = document.activeElement
    dialog.showModal()
    const release = acquireBodyScrollLock()
    return () => { if (dialog.open) dialog.close(); release(); opener?.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => {
    if (existing) return undefined
    let live = true
    api.lengths().then(rows => {
      if (!live) return
      setLengths(rows)
      const fits = lengthsThatFit(free, rows.map(row => row.minutes))
      const chosen = fits.includes(60) ? 60 : fits.at(-1) ?? null
      setMinutes(chosen)
      if (chosen) setStart(startsThatFit(free, chosen, date === today() ? nowMinutes() : 0)[0] ?? null)
    }, failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [api, existing, free, date])

  const day = offer?.date || date
  const earliest = day === today() ? nowMinutes() : 0
  const fits = lengths && free ? lengthsThatFit(free, lengths.map(row => row.minutes)) : []
  const starts = free && minutes ? startsThatFit(free, minutes, earliest) : []
  const shownStart = offer ? offer.start_minutes : start
  const choices = shownStart != null ? closingChoices(day, shownStart) : []
  const usual = offer ? Number(offer.normal_price_gbp) : lengths?.find(row => row.minutes === minutes)?.price
  const amount = Number(price)
  const priceProblem = price.trim() && !(amount > 0 && amount < 10000 && Math.round(amount * 100) === amount * 100) ? 'Enter a price in pounds, for example 55.' : ''
  const ready = !busy && amount > 0 && !priceProblem && choices.length > 0

  function chooseLength(value) {
    setMinutes(value)
    const next = startsThatFit(free, value, earliest)
    setStart(next.includes(start) ? start : next[0] ?? null)
    setClosing(0)
  }
  async function create(event) {
    event.preventDefault()
    if (!ready || start == null || !minutes) return
    setBusy(true); setError('')
    try {
      const made = await api.create({ date, start, minutes, price: amount, closesAt: choices[closing].at })
      setOffer(made); changed?.()
    } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  async function save(event) {
    event.preventDefault()
    if (!ready) return
    setBusy(true); setError('')
    try { setOffer(await api.update(offer.id, { price: amount, closesAt: choices[closing].at })); setEditing(false); changed?.() }
    catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  async function stop() {
    setBusy(true); setError('')
    try { await api.stop(offer.id); changed?.(); close() } catch (failure) { setError(failure.message); setBusy(false) }
  }
  const message = offer ? offerMessage(offer, today()) : ''
  async function copy() {
    setSaid('')
    try { await navigator.clipboard.writeText(message); setSaid('Copied. Paste it into WhatsApp, or anywhere.') } catch { setSaid('Could not copy. Press and hold the message to copy it.') }
  }

  const cancel = event => { event.preventDefault(); event.stopPropagation(); if (!busy) close() }
  const priceField = <label className="admin-field">Special price (£)
    <input inputMode="decimal" value={price} disabled={busy} placeholder="55" onChange={event => setPrice(event.target.value.replace(/[£\s]/g, ''))} aria-describedby="offer-price-hint" />
    <span className="admin-detail-hint" id="offer-price-hint">{usual ? `Usual price ${money(usual)}. ` : ''}This is all they pay: no travel fee or extras on top.</span>
  </label>
  const closingField = choices.length > 0
    ? <label className="admin-field">Stop offering it<select value={closing} disabled={busy} onChange={event => setClosing(Number(event.target.value))}>{choices.map((choice, index) => <option key={choice.minutes} value={index}>{choice.label}</option>)}</select></label>
    : <p className="admin-field-error" role="alert">This time is about to start, so it can no longer be offered.</p>

  return <dialog ref={ref} className="admin-confirm admin-action admin-offer" aria-labelledby="offer-title" onCancel={cancel}>
    {!offer ? <form onSubmit={create}>
      <h2 id="offer-title">Offer at a special price</h2>
      <p className="admin-detail-hint">{dateLabel(date, { weekday: 'long', day: 'numeric', month: 'long' })}. Free {time(free.start)} – {time(free.end)}. You get a message and a link to send; the first client to book gets it.</p>
      {!lengths && !error && <p role="status">Getting your treatments…</p>}
      {lengths && !fits.length && <p role="alert" className="admin-field-error">None of your treatment lengths fits in this free time.</p>}
      {fits.length > 0 && <>
        <fieldset className="admin-offer-lengths"><legend>Length</legend>
          {fits.map(value => <label key={value}><input type="radio" name="offer-length" checked={minutes === value} disabled={busy} onChange={() => chooseLength(value)} /> {value} min</label>)}
        </fieldset>
        {starts.length > 1 && <label className="admin-field">Start<select value={start ?? ''} disabled={busy} onChange={event => { setStart(Number(event.target.value)); setClosing(0) }}>{starts.map(value => <option key={value} value={value}>{time(value)} – {time(value + minutes)}</option>)}</select></label>}
        {starts.length === 1 && <p className="admin-detail-hint">{time(starts[0])} – {time(starts[0] + minutes)}</p>}
        {starts.length === 0 && <p role="alert" className="admin-field-error">That length no longer fits before this time ends.</p>}
        {priceField}
        {starts.length > 0 && closingField}
      </>}
      {error && <p role="alert" className="admin-field-error">{error}</p>}
      <div className="admin-payment-buttons admin-sticky-actions">
        <button type="button" className="btn--quiet" disabled={busy} onClick={close}>Go back</button>
        <button type="submit" className="btn--primary" disabled={!ready || start == null}>{busy ? 'Creating…' : 'Create offer'}</button>
      </div>
    </form> : <form onSubmit={save}>
      <h2 id="offer-title">Special offer</h2>
      <p className="admin-offer-summary"><strong>{dateLabel(offer.date, { weekday: 'long', day: 'numeric', month: 'long' })}</strong><span>{offerSummary(offer)}</span>
        <span className="admin-detail-hint">Open until {londonClock(new Date(offer.closes_at))}{offer.date !== today() ? ` on ${dateLabel(offer.date, { weekday: 'short', day: 'numeric', month: 'short' })}` : ''}. Anyone with the link can book it.</span></p>
      <p className="admin-offer-message" aria-label="Message to send">{message}</p>
      <div className="admin-payment-buttons">
        <a className="btn btn--primary" href={whatsappOfferLink(message)} target="_blank" rel="noopener noreferrer"><Icon name="chat" size={18} />Send on WhatsApp</a>
        <button type="button" className="btn--tonal" onClick={copy}><Icon name="copy" size={18} />Copy message</button>
      </div>
      {said && <p role="status" className="admin-detail-hint">{said}</p>}
      {editing ? <>
        {priceField}
        {closingField}
        <div className="admin-payment-buttons"><button type="button" className="btn--quiet" disabled={busy} onClick={() => { setEditing(false); setPrice(String(Number(offer.price_gbp))) }}>Keep as it was</button><button type="submit" className="btn--primary" disabled={!ready}>{busy ? 'Saving…' : 'Save changes'}</button></div>
      </> : !stopping && <div className="admin-payment-buttons">
        <button type="button" className="btn--quiet" disabled={busy} onClick={() => { setEditing(true); setClosing(Math.max(0, choices.findIndex(choice => Math.abs(choice.at.getTime() - Date.parse(offer.closes_at)) < 60000))) }}>Change price or closing time</button>
        <button type="button" className="btn--danger btn--small" disabled={busy} onClick={() => setStopping(true)}>Stop offer</button>
      </div>}
      {stopping && <div role="alert" className="admin-conflicts"><p>Stop this offer? The link will say the time is no longer available. Nobody has booked it yet.</p>
        <div className="admin-payment-buttons"><button type="button" disabled={busy} onClick={() => setStopping(false)}>Keep it</button><button type="button" className="btn--danger-solid" disabled={busy} onClick={stop}>{busy ? 'Stopping…' : 'Yes, stop it'}</button></div></div>}
      {error && <p role="alert" className="admin-field-error">{error}</p>}
      <div className="admin-payment-buttons admin-sticky-actions"><button type="button" className="btn--quiet" disabled={busy} onClick={close}>Done</button></div>
    </form>}
  </dialog>
}
