import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { createGiftApi, sendAtFor } from './giftApi.js'
import { designsInOrder, giftChoices, isChristmasTime, MESSAGE_LIMIT, occasionsInOrder, travelChoice, travelPart, whole, withLove } from './giftWords.js'
import VoucherCard from './VoucherCard.jsx'
import BankDetails from '../booking/components/BankDetails.jsx'
import { bankFromSettings, chooseBank, paymentConfig } from '../booking/paymentConfig.js'
import { friendlyError } from '../booking/friendlyError.js'
import '../booking/booking.css'
import './voucher.css'
import './gift.css'

const fallbackBank = paymentConfig(import.meta.env)
const emailOk = value => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())
const londonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date())

function Choice({ pressed, onClick, title, note, children, className = '' }) {
  return <button type="button" className={`gift-choice ${className}`} aria-pressed={pressed} onClick={onClick}>
    <span className="gift-radio" aria-hidden="true" /><span className="gift-choice-text"><span className="gift-choice-title">{title}</span>{note && <span className="gift-choice-note">{note}</span>}</span>{children}
  </button>
}

// /gift: buy a massage as a present. Anyone can, with no account: they pay by bank transfer and Vadim sends the voucher once it arrives.
export default function GiftShop({ client = supabase }) {
  const api = useMemo(() => createGiftApi(client), [client])
  const [options, setOptions] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const designs = useMemo(() => designsInOrder(), [])
  const occasions = useMemo(() => occasionsInOrder(), [])
  const [pick, setPick] = useState(null)
  const [design, setDesign] = useState(designs[0].id)
  const [to, setTo] = useState('')
  const [from, setFrom] = useState('')
  const [occasion, setOccasion] = useState(0)
  const [line, setLine] = useState(0)
  const [custom, setCustom] = useState(null)
  const [area, setArea] = useState('unsure')
  const [cover, setCover] = useState('all')
  const [delivery, setDelivery] = useState('self')
  const [recipientEmail, setRecipientEmail] = useState('')
  const [sendDay, setSendDay] = useState('')
  const [buyer, setBuyer] = useState({ name: '', email: '', phone: '' })
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [token, setToken] = useState(() => new URLSearchParams(window.location.search).get('t'))
  const [purchase, setPurchase] = useState(null)

  useEffect(() => { document.title = 'Give a massage as a gift · VadMassage' }, [])
  useEffect(() => {
    let live = true
    api.options().then(data => { if (live) { setOptions(data); setLoadError('') } }, failure => { if (live) setLoadError(friendlyError(failure)) })
    return () => { live = false }
  }, [api, attempt])
  useEffect(() => {
    if (!token) return undefined
    let live = true
    api.purchase(token).then(data => { if (live) setPurchase(data || { missing: true }) }, failure => { if (live) setError(friendlyError(failure)) })
    return () => { live = false }
  }, [api, token])

  const choices = useMemo(() => (options ? giftChoices(options.lengths) : []), [options])
  const chosen = choices.find(item => item.key === pick) || choices.find(item => item.loved) || choices[0]
  const message = custom ?? withLove(occasions[occasion].messages[line], from || '…')
  const travel = options ? travelPart(options, { area, cover }) : 0
  const total = chosen ? chosen.price + travel : 0
  const areaRow = options?.areas.find(item => item.id === area)
  const problems = {
    to: !to.trim() && 'Who is the voucher for?',
    from: !from.trim() && 'Who is it from?',
    message: message.length > MESSAGE_LIMIT && `Please keep the message to ${MESSAGE_LIMIT} letters.`,
    recipientEmail: delivery === 'email' && !emailOk(recipientEmail) && 'Please add their email.',
    sendDay: delivery === 'email' && !sendDay && 'Choose the day it should arrive.',
    buyerName: !buyer.name.trim() && 'Please add your name.',
    buyerEmail: !emailOk(buyer.email) && 'Please add your email, so I can send you the voucher.',
  }
  const firstProblem = Object.entries(problems).find(([, text]) => text)
  const show = key => tried && problems[key] ? <p className="gift-problem" id={`gift-${key}-problem`}>{problems[key]}</p> : null

  async function buy(event) {
    event.preventDefault()
    setTried(true)
    if (firstProblem) { document.getElementById(`gift-${firstProblem[0]}`)?.focus(); return }
    setBusy(true); setError('')
    try {
      const result = await api.buy({ minutes: chosen.minutes, people: chosen.people, travelChoice: travelChoice({ area, cover }), areaId: area === 'unsure' ? null : area,
        design, to, from, message, delivery, recipientEmail, sendAt: sendAtFor(sendDay), buyerName: buyer.name, buyerEmail: buyer.email, buyerPhone: buyer.phone })
      const url = new URL(window.location.href)
      url.searchParams.set('t', result.token)
      window.history.replaceState(null, '', url)
      setPurchase({ status: 'awaiting_payment', reference: result.reference, amount: result.amount, recipient_name: to.trim(), minutes: chosen.minutes, people: chosen.people,
        bank: result.bank, delivery, recipient_email: recipientEmail.trim(), transfer_declared: false })
      setToken(result.token)
      window.scrollTo(0, 0)
    } catch (failure) { setError(friendlyError(failure)) } finally { setBusy(false) }
  }
  async function transferMade() {
    setBusy(true); setError('')
    try { setPurchase(await api.transferMade(token)) } catch (failure) { setError(friendlyError(failure)) } finally { setBusy(false) }
  }

  const shell = children => <div className="booking-shell gift-shell">
    <header className="brand"><a className="brand-link" href="/"><b className="brand-mark" aria-hidden="true">VM</b>VadMassage</a><a className="brand-aside" href="/">Book for yourself</a></header>
    <main className="booking-main gift-main">{children}</main>
    <footer>Personal treatments, thoughtfully arranged. <a href="https://vadmassage.com">Contact Vadim</a> · <a href="/faq">Questions and answers</a></footer>
  </div>

  // After buying (or coming back with the private link): how to pay, then the voucher once it is paid.
  if (token) {
    if (!purchase) return shell(<>{error ? <p role="alert" className="error">{error}</p> : <p role="status">Loading your gift…</p>}</>)
    if (purchase.missing) return shell(<><h1 tabIndex={-1}>That link doesn't <em>work</em></h1><p className="lede">Please check it, or message Vadim.</p><a className="btn btn--primary" href="/gift">Buy a gift voucher</a></>)
    const bank = chooseBank(bankFromSettings(purchase.bank), fallbackBank)
    if (purchase.status === 'ready' || purchase.status === 'used') return shell(<>
      <h1 tabIndex={-1}>Your gift is <em>ready</em></h1>
      <p className="lede">Thank you, the payment has arrived. {purchase.delivery === 'email' && purchase.status === 'ready' ? `It will be emailed to ${purchase.recipient_email} on the day you chose. You can also open it yourself:` : 'Open it to print it, save it or send it on WhatsApp.'}</p>
      <a className="btn btn--primary btn--lg btn--block" href={`/gift/${purchase.code}`}>Open the voucher</a>
      <p className="fine">Code: <strong>{purchase.code}</strong></p>
    </>)
    if (purchase.status === 'cancelled') return shell(<><h1 tabIndex={-1}>This gift was <em>cancelled</em></h1><p className="lede">Please message Vadim if you have any questions.</p></>)
    return shell(<>
      <h1 tabIndex={-1}>One last <em>step</em></h1>
      <p className="lede">To finish your gift for {purchase.recipient_name}, please make a bank transfer. As soon as it arrives I'll email you the voucher.</p>
      <section className="amount-card" aria-label="Amount to transfer"><p className="eyebrow">Amount to transfer</p><p className="amount figure">{whole(purchase.amount)}</p></section>
      <section className="panel bank-card"><h2>Bank transfer</h2><BankDetails bank={bank} reference={purchase.reference} /></section>
      {error && <p role="alert" className="error">{error}</p>}
      {purchase.transfer_declared
        ? <p role="status" className="reserved"><span className="reserved-dot" aria-hidden="true" />Thank you! I'll check my bank and send you the voucher.</p>
        : <div className="action-bar"><button className="btn--primary btn--lg btn--block" disabled={busy || !bank.configured} onClick={transferMade}>I've made the bank transfer</button></div>}
      <p className="fine">Keep this page's link to come back to your gift. The voucher is valid for {options?.months || 12} months from payment.</p>
    </>)
  }

  if (loadError) return shell(<><p role="alert" className="error">{loadError}</p><button className="btn--tonal" onClick={() => setAttempt(value => value + 1)}>Try again</button></>)
  if (!options) return shell(<div className="skeleton-rows" role="status"><span className="sr-only">Loading…</span><span className="skeleton" /><span className="skeleton" /></div>)
  if (!options.on || !chosen) return shell(<><h1 tabIndex={-1}>Gift vouchers are <em>resting</em></h1><p className="lede">They aren't on sale right now. Please message Vadim and he'll help.</p></>)

  const preview = { code: null, minutes: chosen.minutes, people: chosen.people, recipient_name: to.trim() || 'Mum', from_name: from.trim() || 'Anna', message, design, expires_at: null }
  return shell(<form onSubmit={buy} noValidate>
    <section className="gift-hero">
      <div className="gift-snow" aria-hidden="true" />
      <p className="gift-eyebrow">{isChristmasTime() ? 'Christmas gift vouchers' : 'Gift vouchers'}</p>
      <h1 tabIndex={-1}>Give the gift of <em>calm</em></h1>
      <p>A massage at home, on a day that suits them. Ready in minutes, valid for {options.months} months.</p>
      <div className="gift-preview"><VoucherCard voucher={preview} qrText={`${window.location.origin}/gift`} /></div>
    </section>

    <section className="gift-step" aria-labelledby="gift-s1"><h2 id="gift-s1"><span>1</span>Choose the gift</h2>
      <div className="gift-tiles">{choices.map(item => <button type="button" key={item.key} className="gift-tile" aria-pressed={item.key === chosen.key} onClick={() => setPick(item.key)}>
        {item.loved && <span className="gift-badge">Most loved</span>}<span className="gift-tile-title">{item.title}</span><span className="gift-tile-note">{item.note}</span><b>{whole(item.price)}</b></button>)}</div>
    </section>

    <section className="gift-step" aria-labelledby="gift-s2"><h2 id="gift-s2"><span>2</span>Choose the design</h2>
      <div className="gift-designs">{designs.map(item => <button type="button" key={item.id} className="gift-design" aria-pressed={item.id === design} onClick={() => setDesign(item.id)}>
        <span className={`gift-swatch gift-swatch--${item.id}`} aria-hidden="true" />{item.name}</button>)}</div>
    </section>

    <section className="gift-step" aria-labelledby="gift-s3"><h2 id="gift-s3"><span>3</span>Add a personal message</h2>
      <div className="gift-names">
        <label className="field">For<input id="gift-to" value={to} maxLength={60} autoComplete="off" placeholder="Mum" aria-invalid={Boolean(tried && problems.to) || undefined} onChange={e => setTo(e.target.value)} />{show('to')}</label>
        <label className="field">From<input id="gift-from" value={from} maxLength={60} autoComplete="given-name" placeholder="Anna" aria-invalid={Boolean(tried && problems.from) || undefined} onChange={e => setFrom(e.target.value)} />{show('from')}</label>
      </div>
      <p className="gift-label" id="gift-occasion-label">Pick a ready message, or write your own</p>
      <div className="gift-chips" role="group" aria-labelledby="gift-occasion-label">{occasions.map((item, index) => <button type="button" key={item.name} className="gift-chip" aria-pressed={index === occasion} onClick={() => { setOccasion(index); setLine(0); setCustom(null) }}>{item.name}</button>)}</div>
      <div className="gift-lines">{occasions[occasion].messages.map((text, index) => <button type="button" key={text} className="gift-line" aria-pressed={custom === null && index === line} onClick={() => { setLine(index); setCustom(null) }}>“{text}”</button>)}</div>
      <label className="field">Your message (you can change it)<textarea id="gift-message" rows={3} value={message} maxLength={MESSAGE_LIMIT + 20} onChange={e => setCustom(e.target.value)} />{show('message')}</label>
    </section>

    <section className="gift-step" aria-labelledby="gift-s4"><h2 id="gift-s4"><span>4</span>Where do they live?</h2>
      <p className="gift-hint">So the travel fee and congestion charge can be included.</p>
      <div className="gift-chips">
        <button type="button" className="gift-chip" aria-pressed={area === 'unsure'} onClick={() => setArea('unsure')}>Not sure yet</button>
        {options.areas.map(item => { const extra = Number(item.travel) + Number(item.congestion); return <button type="button" key={item.id} className="gift-chip" aria-pressed={area === item.id} onClick={() => setArea(item.id)}>{item.name}{extra > 0 ? ` · +${whole(extra)}` : ''}</button> })}
      </div>
      {area === 'unsure' ? <div className="gift-stack">
        <Choice pressed={cover === 'all'} onClick={() => setCover('all')} title="Everything included" note={`+${whole(options.all_areas_cover)}. Covers any travel fee or congestion charge, wherever they live in my areas. Nothing to pay when they book.`} />
        <Choice pressed={cover === 'none'} onClick={() => setCover('none')} title="Just the massage" note="If they live where there is a travel fee or congestion charge, they pay only that when they book." />
        {cover === 'all' && Number(options.all_areas_cover) > 0 && <p className="gift-hint">One simple price for anywhere in my areas, so they never pay extra. It is a flat amount and isn't refunded if their area has no charge.</p>}
      </div> : <p className="gift-hint">{Number(areaRow?.travel) + Number(areaRow?.congestion) > 0
        ? `The ${whole(Number(areaRow.travel) + Number(areaRow.congestion))} ${[Number(areaRow.travel) > 0 && 'travel fee', Number(areaRow.congestion) > 0 && 'congestion charge'].filter(Boolean).join(' and ')} ${Number(areaRow.travel) > 0 && Number(areaRow.congestion) > 0 ? 'are' : 'is'} included, so they pay nothing when they book.`
        : `No travel fee in ${areaRow?.name}, so the voucher covers everything.`}</p>}
    </section>

    <section className="gift-step" aria-labelledby="gift-s5"><h2 id="gift-s5"><span>5</span>How should it arrive?</h2>
      <div className="gift-stack">
        <Choice pressed={delivery === 'self'} onClick={() => setDelivery('self')} title="I'll give it myself" note="A voucher to print or save as a PDF, plus a button to send it on WhatsApp." />
        <Choice pressed={delivery === 'email'} onClick={() => setDelivery('email')} title="Surprise them by email" note="It arrives on the day you choose, in a red envelope they open and scratch to reveal." />
      </div>
      {delivery === 'email' && <div className="gift-names">
        <label className="field">Their email<input id="gift-recipientEmail" type="email" inputMode="email" autoComplete="off" value={recipientEmail} aria-invalid={Boolean(tried && problems.recipientEmail) || undefined} onChange={e => setRecipientEmail(e.target.value)} />{show('recipientEmail')}</label>
        <label className="field">On which day?<input id="gift-sendDay" type="date" min={londonToday()} value={sendDay} aria-invalid={Boolean(tried && problems.sendDay) || undefined} onChange={e => setSendDay(e.target.value)} /><span className="field-hint">It arrives at 8 in the morning, once the payment has arrived.</span>{show('sendDay')}</label>
      </div>}
    </section>

    <section className="gift-step" aria-labelledby="gift-s6"><h2 id="gift-s6"><span>6</span>Your details</h2>
      <p className="gift-hint">So I can send you the payment details and the voucher.</p>
      <label className="field">Your name<input id="gift-buyerName" autoComplete="name" value={buyer.name} aria-invalid={Boolean(tried && problems.buyerName) || undefined} onChange={e => setBuyer({ ...buyer, name: e.target.value })} />{show('buyerName')}</label>
      <label className="field">Your email<input id="gift-buyerEmail" type="email" inputMode="email" autoComplete="email" value={buyer.email} aria-invalid={Boolean(tried && problems.buyerEmail) || undefined} onChange={e => setBuyer({ ...buyer, email: e.target.value })} />{show('buyerEmail')}</label>
      <label className="field">Your phone (optional)<input id="gift-buyerPhone" type="tel" inputMode="tel" autoComplete="tel" value={buyer.phone} onChange={e => setBuyer({ ...buyer, phone: e.target.value })} /></label>
    </section>

    <section className="gift-total" aria-live="polite">
      <div><p className="gift-total-label">Total</p><p className="gift-total-sum figure">{whole(total)}</p>
        <p className="gift-hint">{chosen.title}{travel > 0 ? ` + ${whole(travel)} ${area === 'unsure' ? 'travel and congestion, any area' : 'travel and congestion'}` : ''}. Paid by bank transfer.</p></div>
      {error && <p role="alert" className="error">{error}</p>}
      {tried && firstProblem && <p role="alert" className="gift-problem">{firstProblem[1]}</p>}
      <button type="submit" className="btn--primary btn--lg btn--block" disabled={busy}>{busy ? 'Please wait…' : 'Continue to payment'}</button>
    </section>
  </form>)
}
